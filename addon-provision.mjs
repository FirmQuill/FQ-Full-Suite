import {execFile} from 'node:child_process';
import {createHash,createPublicKey} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {activationOptionsFromEnv} from './module-activation.mjs';
import {addonOptionsFromEnv} from './addon-installer.mjs';
import {publisherPublicKey,entitlementPublicKey} from './release-verifiers.mjs';

const exec=promisify(execFile);
const legacySettings=['FIRMQUILL_MODULE_INSTALL_DIR','FIRMQUILL_ENTITLEMENT_PUBLIC_KEY',
  'FIRMQUILL_ADDON_PUBLISHER_PUBLIC_KEY','FIRMQUILL_PACKAGE_PUBLISHER_PUBLIC_KEY',
  'FIRMQUILL_PACKAGES_DIR','FIRMQUILL_SIGNED_SUPPORT_PACKAGE','FIRMQUILL_SUPPORT_PACKAGE_PUBLIC_KEY'];

// Windows PowerShell uses the .NET Framework overload that supplies the ACL
// when creating the directory. It leaves an existing directory's ACL intact.
const prepare=String.raw`
$ErrorActionPreference='Stop'
$operator=[Security.Principal.WindowsIdentity]::GetCurrent().User
$privateOwners=@($operator.Value,'S-1-5-18')
$trustedOwners=$privateOwners+@('S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Check-Location($item,[bool]$private){
  if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked licensing location'}
  $acl=Get-Acl -LiteralPath $item.FullName
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowed=if($private){$privateOwners}else{$trustedOwners}
  if($allowed -notcontains $owner){throw 'Untrusted licensing location owner'}
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  if($null -eq $raw.DiscretionaryAcl){throw 'Unrestricted licensing location'}
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
    if($rule.AccessControlType -ne 'Allow' -or $allowed -contains $rule.IdentityReference.Value){continue}
    # A private object's inheritable rights must also keep future files private.
    # On ancestors only effective rights to replace or redirect the path matter.
    if($private -or (-not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
      ($rule.FileSystemRights.value__ -band 0x500D0140))){throw 'Untrusted licensing access'}
  }
}
function Check-Parents($root){
  $parent=Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($root)) -Force
  for($ancestor=$parent;$null -ne $ancestor;$ancestor=$ancestor.Parent){Check-Location $ancestor $false}
}
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($operator)
$security.SetAccessRuleProtection($true,$false)
foreach($id in $privateOwners){
  $sid=[Security.Principal.SecurityIdentifier]::new($id)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
$root=$env:FQ_LICENSE_DIRECTORY
$local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$fallback=if($local){[IO.Path]::Combine($local,'FirmQuill-licensing-'+$env:FQ_LICENSE_WORKSPACE)}
# Once a workspace uses its per-user directory, keep that installation ID even
# if permissions on the workspace's ancestors change.
if($fallback -and (Test-Path -LiteralPath $fallback)){
  $root=$fallback
  Check-Parents $root
  [void][IO.Directory]::CreateDirectory($root,$security)
}else{
  try{
    Check-Parents $root
    [void][IO.Directory]::CreateDirectory($root,$security)
  }catch{
    if(!$fallback){throw}
    $root=$fallback
    Check-Parents $root
    [void][IO.Directory]::CreateDirectory($root,$security)
  }
}
$directory=Get-Item -LiteralPath $root -Force
if(!$directory.PSIsContainer -or !(Get-Acl -LiteralPath $root).AreAccessRulesProtected){throw 'Licensing directory is not protected'}
Check-Location $directory $true
function Install-Verifier([string]$name,[string]$encoded){
  $target=[IO.Path]::Combine($root,$name)
  if(![IO.File]::Exists($target)){
    $stage=[IO.Path]::Combine($root,[Guid]::NewGuid().ToString('N')+'.tmp')
    $stream=[IO.File]::Open($stage,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{
      try{$bytes=[Convert]::FromBase64String($encoded);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
      # Move only into a missing target. A concurrent first launch may win.
      try{[IO.File]::Move($stage,$target)}catch [IO.IOException]{if(![IO.File]::Exists($target)){throw}}
    }finally{[IO.File]::Delete($stage)}
  }
  $file=Get-Item -LiteralPath $target -Force
  Check-Location $file $true
  if($file.PSIsContainer -or $file.Length -gt 512 -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -cne $encoded){
    throw 'The persisted verifier differs from this release'
  }
}
Install-Verifier 'publisher-public.pem' $env:FQ_LICENSE_PUBLISHER
Install-Verifier 'entitlement-public.pem' $env:FQ_LICENSE_ENTITLEMENT
foreach($name in 'installation-id','active-entitlement.fqlicense','upgrade-recipient.pem'){
  $path=[IO.Path]::Combine($root,$name)
  if(Test-Path -LiteralPath $path){Check-Location (Get-Item -LiteralPath $path -Force) $true}
}
Write-Output ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($root)))
`;

function pinnedBytes(pem){
  if(typeof pem!=='string'||!pem.startsWith('-----BEGIN PUBLIC KEY-----')||createPublicKey(pem).asymmetricKeyType!=='ed25519'){
    throw Error('Invalid release verifier.');
  }
  return Buffer.from(pem,'utf8').toString('base64');
}

export async function releaseAddonOptions(database,env=process.env){
  const legacy={activationOptions:activationOptionsFromEnv(env),addonOptions:addonOptionsFromEnv(env)};
  if(process.platform!=='win32'||legacySettings.some(key=>Object.hasOwn(env,key)))return legacy;
  const systemRoot=process.env.SystemRoot||'C:\\Windows';
  try{
    const canonicalDatabase=await realpath(database);
    const workspaceHash=createHash('sha256').update(canonicalDatabase).digest('hex');
    const result=await exec(join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoProfile','-NonInteractive','-Command',prepare],{
        timeout:15000,maxBuffer:4096,windowsHide:true,
        env:{SystemRoot:systemRoot,FQ_LICENSE_DIRECTORY:join(dirname(database),'FirmQuill-licensing'),
          FQ_LICENSE_WORKSPACE:workspaceHash,FQ_LICENSE_PUBLISHER:pinnedBytes(publisherPublicKey),
          FQ_LICENSE_ENTITLEMENT:pinnedBytes(entitlementPublicKey)}
      });
    const directory=Buffer.from(result.stdout.trim(),'base64').toString('utf8');
    if(!isAbsolute(directory))throw Error('Licensing permissions could not be verified.');
    return {activationOptions:{directory,verifierPath:join(directory,'entitlement-public.pem')},
      addonOptions:{...legacy.addonOptions,publisherKey:join(directory,'publisher-public.pem')}};
  }catch{
    process.emitWarning('Signed add-ons are unavailable. Check the private licensing directory permissions and release verification keys.');
    return legacy;
  }
}
