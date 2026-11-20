# Shared live control

Run the bridge on one Windows PC or Mac that can reach the ETC Eos desk. Operators use Chrome or Edge to open a private HTTPS address from the same network. They use the bridge host's cue sheet and console connection. Camera recognition runs in each browser. Speech audio travels over HTTPS to the host for offline recognition.

## Set up the bridge host

1. Download the Light Magic controller on the host and install Python. Install speech recognition there if you use microphone input. Install Caddy 2.8 or later and make `caddy` available on the command line. [Caddy installation](https://caddyserver.com/docs/install)
2. Choose a private network address that the operator computers can reach. The example uses `192.168.1.25:8443`. Substitute your bridge host's address. If using a hostname, make sure operator computers resolve it to the host's private address.
3. Generate a random bridge key with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Set the same `LIGHT_MAGIC_PROXY_KEY` in the environments for Light Magic and Caddy. Use a separate password for the operator. Run `caddy hash-password` and set its output as `LIGHT_MAGIC_PASSWORD_HASH` for Caddy. The included configuration uses the username `operator`.
4. Set `LIGHT_MAGIC_SHARED_HOST` to the hostname or IP with the HTTPS port, such as `192.168.1.25:8443`. Set `LIGHT_MAGIC_BIND_ADDRESS` to the host's private IP without a port and `LIGHT_MAGIC_OPERATOR_NETWORK` to the operator subnet in CIDR form, such as `192.168.1.0/24`. These settings are for Caddy. Allow incoming HTTPS from that subnet in the host firewall.
5. Stop any existing Light Magic process on the host. Start the bridge and Caddy in separate terminals from the project folder. Use the same Python environment you use for local Light Magic.

```text
python app.py --no-browser --shared-origin https://192.168.1.25:8443
caddy run --config Caddyfile.shared --adapter caddyfile
```

The included Caddy configuration uses its internal certificate authority. Have the venue administrator install that authority's root certificate on the operator computers, or configure Caddy with a certificate already trusted by those computers. Chrome and Edge need trusted HTTPS for remote camera and microphone access. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https)

## Open the controller

Open the configured HTTPS address and sign in as `operator`. Start a rehearsal to check camera and microphone permissions on that computer. In the live session, confirm the console and show, test outputs, and choose **Go live**. The bridge still gives control to one browser at a time.

Keep port `8765` on loopback. The HTTPS proxy authenticates every route and supplies the bridge key. Share the private HTTPS address and operator credentials with authorized operators. Keep the bridge key on the host.
