import {btn,esc,panel} from '/shared/views.mjs';
const errors={
  'backup-unavailable':'Host backup storage or key is unavailable.',
  'size-limit':'The database exceeds the supported archive size.',
  'storage-failure':'A storage or archive status operation failed. Ask the host operator to check the destination.',
  'encrypted-archive-present':'An archive from this daily slot already exists, but completion was not recorded. Verify a restore before relying on it.'
};
const names={daily:'Scheduled daily run','reviewed-lite-import':'Before a reviewed Lite import'};
export function backupContent(data){
  if(!data)return panel('Managed backups','<p>Loading backup status…</p>');
  if(data.error)return panel('Managed backups','<p>Backup status is unavailable. Refresh or ask your host operator.</p>');
  const {ready,policy,running,lastArchive,lastError,capacity}=data;
  const size=capacity?'<p><strong>Logical database size:</strong> '+esc((capacity.logicalBytes/1048576).toFixed(2))+' MiB · Warning from 56 MiB · Existing recovery limit 64 MiB.</p>'+
    (capacity.status==='over-limit'?'<p class="callout warn">This database exceeds the recovery utility’s 64 MiB database limit. Contact your host operator before relying on this utility.</p>':capacity.status==='near-limit'?'<p class="callout warn">This database is approaching the recovery utility’s 64 MiB database limit. Review your backup and recovery plan.</p>':''):'<p>Logical database size is unavailable.</p>';
  const recovery=panel('Recovery readiness',size+'<p>Size measures the logical SQLite image, not available disk space, backup success, or a verified restore.</p>');
  const status='<p>'+(!ready?'Host recovery key and private storage are not ready. Contact your host operator before enabling backups.':'Private host storage is configured.')+'</p>'+
    '<p>Daily run (UTC): <b>'+esc(policy.dailyUTC||'Off')+'</b> · Backup before approved imports: <b>'+(policy.beforeCommit?'On':'Off')+'</b> · Keep '+esc(policy.retain)+' managed archives.</p>'+
    (running?'<p>A backup is running. Refresh to see its result.</p>':'')+
    (lastArchive?'<h3>Last completed encrypted archive still present</h3><p>'+esc(lastArchive.at)+' · '+esc(names[lastArchive.reason]||'Managed archive')+' · '+esc((lastArchive.databaseBytes/1048576).toFixed(2))+' MiB database image.</p><p>Archive reference: '+esc(lastArchive.name)+'</p>':'<p>No completed encrypted archive is recorded at the current destination.</p>')+
    (errors[lastError]?'<p class="callout warn">'+esc(errors[lastError])+'</p>':'')+
    '<p>Archive creation does not mean a full restore was tested. Coordinate a fresh-directory restore rehearsal with your host operator. The existing 64 MiB archive limit still applies.</p>';
  return recovery+panel('Managed backup policy',status,btn('managed-backup-change','Edit backup policy'));
}
export async function backupAction(type,ctx){
  if(type!=='managed-backup-change')return false;
  if(!ctx.auxiliary?.policy)throw Error('Refresh backup policy before editing.');
  const {policy}=ctx.auxiliary;
  ctx.formModal('Edit managed backup policy','<p>Leave the daily time blank to disable the schedule. Enter a 24-hour UTC time, not your local time. The schedule and event backups are optional.</p>'+
    '<label>Daily UTC time (HH:MM)<input name="dailyUTC" type="text" value="'+esc(policy.dailyUTC)+'" maxlength="5" placeholder="02:00" pattern="[0-9]{2}:[0-9]{2}"></label>'+
    '<label class="checkfield"><input name="beforeCommit" type="checkbox"'+(policy.beforeCommit?' checked':'')+'> Require an encrypted backup immediately before a reviewed Lite import writes records</label>'+
    '<label>Managed archives to keep<input name="retain" type="number" min="2" max="10" value="'+esc(policy.retain)+'" required></label>',
    'Save backup policy',async(v,f)=>{
      await ctx.api('managed-backups',{dailyUTC:v.dailyUTC,beforeCommit:f.has('beforeCommit'),retain:Number(v.retain),version:policy.version});
      ctx.closeModal();await ctx.refresh();ctx.toast('Backup policy saved.');
    });return true;
}
