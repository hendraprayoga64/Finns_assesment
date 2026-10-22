# Task 3 - Linux administration

## Install & enable the service (starts on boot, restarts on failure)
```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin edgeapp
sudo cp edge-webhook.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now edge-webhook.service
systemctl status edge-webhook.service
```

## Search "TIMEOUT" in a 50 GB log, page by page, without eating RAM
```bash
LC_ALL=C grep -n --color=always "TIMEOUT" /var/log/edge-webhook.log | less -R
```
Why it is safe: `grep` streams the file line by line (constant, tiny memory), the pipe is back-pressured by `less`
(grep pauses when the pager is not reading), and `less` only keeps the screen/buffer it needs. `LC_ALL=C` skips
UTF-8 handling = much faster on huge files. Quit with `q` (grep then receives SIGPIPE and stops).
Avoid `cat`, `vim`, or loading the file into an editor.
