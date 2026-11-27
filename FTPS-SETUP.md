# Optional private FTPS file transfer

Full Suite can copy one file (maximum 4 MiB) between an authorized private-drive folder and one fixed, organization-controlled FTP directory over **explicit TLS**. It does not support plain FTP, implicit FTPS, SFTP, remote browsing, or automatic sync. Nothing changes until the site operator configures it and a permitted person uses the transfer controls. Enabling the feature is optional and not needed for FirmQuill, private drives, or local uploads.

Set the following environment values in the private launch environment on the Full Suite server, then restart it. Do not put credentials in a Git repository, shared script, export, or backup. Server launch credentials never live in the application database.

| Environment variable | What it specifies |
|---|---|
| `FIRMQUILL_FTPS_ENABLE` | Set to `1` to enable. Missing or invalid configuration keeps transfers unavailable. |
| `FIRMQUILL_FTPS_HOST`, `FIRMQUILL_FTPS_PORT` | Fixed DNS name or IPv4 address of your organization's FTPS server; default port 21. Must present a certificate matching this exact name or IP. |
| `FIRMQUILL_FTPS_FOLDER` | Fixed path relative to the FTP account's home, using slash-separated simple names such as `firmquill/inbox`. Leave empty for the account home. |
| `FIRMQUILL_FTPS_COMPANY_ID`, `FIRMQUILL_FTPS_GROUP_ID` | The exact company ID and, for a shared drive, exact group ID. Omit the group only for a personal drive. Changing companies or groups in the UI does not change the route. |
| `FIRMQUILL_FTPS_OPERATOR_IDS` | The explicitly authorized main-portal account IDs, comma-separated (one only for a personal drive). They also need current access to the actual drive and file or folder. Display names/usernames are not IDs. IDs are available in the owner account Users API and the authorized drive scope data; never put credentials in either API. |
| `FIRMQUILL_FTPS_USERNAME`, `FIRMQUILL_FTPS_PASSWORD` | Dedicated, low-privilege FTP login. Give it access only to the designated folder; FTP-side ACLs and network egress controls still apply. |
| `FIRMQUILL_FTPS_CA_FILE` | Optional absolute path to the operator-managed PEM CA bundle, for internal PKI. Omit to use curl's normal trust settings. TLS verification cannot be disabled. |

Use a maintained curl build with FTP/TLS support in the host's trusted executable path. Use passive mode; the FTP server's advertised data address cannot redirect curl to another host. The connection fails closed if the server does not support verified TLS. Keep the server and its temporary directory restricted to its operating account: during upload a private temporary copy is removed when curl finishes; after an unclean server shutdown remove any leftover `firmquill-ftps-*` directory in the host temp location. This client never reads or seeds FTP credentials from backups. On the FTPS server, use access and retention policies suitable for the files you move.

In the matching drive folder, pick a file and use **Upload one copy**, or enter the exact remote filename to **Download into this folder**. Uploads get an identifier-prefixed unique name; the confirmation gives the remote name to copy. Failed uploads may leave partial remote copies; FirmQuill does not issue remote delete commands. Downloads are saved only after a successful transfer and a fresh access check. The workspace audit records successful transfer direction and actor, not host, credentials, filenames or file contents.
