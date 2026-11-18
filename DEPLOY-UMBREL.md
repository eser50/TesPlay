# Run on umbrelOS (Portainer + Tailscale)

1. In Portainer: **Stacks → Add stack → Repository**.
   - Repository URL: this repository. Reference: `refs/heads/youtube-source`.
   - Compose path: `docker-compose.umbrel.yml`.
2. Add the stack environment variables listed at the top of that file.
   `APP_ORIGIN` must be the https name Tailscale gives your Umbrel
   (admin console → Machines, or `tailscale status`).
3. **Deploy the stack.** Check the logs for startup problems.
4. Put HTTPS in front of it with Tailscale (run on the Umbrel; confirm the
   container name with `docker ps | grep tailscale`):

   ```sh
   docker exec tailscale_web_1 tailscale serve --bg --https=443 http://192.168.1.246:3100
   ```

   If it says HTTPS is not enabled for the tailnet, enable HTTPS certificates
   in the Tailscale admin console (DNS page) and run it again.
5. Open `APP_ORIGIN` from a device on your tailnet, sign in with a Jellyfin
   account, and look for the **YouTube** tab.

If sign-in loops or the client IP shows as an internal address, set
`TRUST_PROXY` to the address that actually connects to the player (it is in the
player's access log).
