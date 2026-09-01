# Deploying Fixify to Oracle Cloud (Always Free)

This walks through taking the app from your machine to a real, publicly
reachable VPS with a self-hosted Postgres database, Docker, and HTTPS.
Oracle Cloud's "Always Free" tier gives you an ARM instance (up to 4 OCPUs /
24GB RAM) for $0/month forever — plenty for a pilot.

Every step below needs to be run by you — account creation, payment details,
and SSH access can't be done on your behalf. Ask me at any point if a step
doesn't go as described; paste the actual error and I'll help debug it.

---

## 1. Create the Oracle Cloud account and VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (a card is required for identity verification, but Always Free resources are never charged).
2. **Compute → Instances → Create Instance.**
3. Name it (e.g. `fixify-vps`).
4. Under "Image and shape," click **Edit**:
   - Image: **Canonical Ubuntu 24.04** (or 22.04)
   - Shape: **Ampere → VM.Standard.A1.Flex** — set 2 OCPUs / 12GB RAM to start (you can go up to 4/24 free)
5. Under "Add SSH keys," either paste your own public key (`ssh-keygen -t ed25519` locally if you don't have one) or let Oracle generate one — download and save the private key if so.
6. Confirm "Assign a public IPv4 address" is checked, then **Create**.
7. Note the instance's **public IP** once it's running.

## 2. Open the firewall — the #1 thing that trips people up on Oracle

Oracle blocks everything but SSH by default, at **two separate layers** — you need to open both:

**a) The cloud-level firewall (Security List):**
Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List → **Add Ingress Rules**:
- Source CIDR `0.0.0.0/0`, TCP, destination port `80`
- Source CIDR `0.0.0.0/0`, TCP, destination port `443`

**b) The instance's own firewall (iptables, pre-configured on Oracle's Ubuntu image):**
SSH in first (`ssh ubuntu@<public-ip>`), then:
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```
If you skip either layer, the app will work over SSH tunneling but be unreachable from the actual internet — a very common "why can't I load my site" dead end on Oracle specifically.

## 3. Install Docker, Nginx, and Certbot

```bash
sudo apt update && sudo apt upgrade -y

# Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker   # or log out/in for the group change to take effect

# Nginx + Certbot (for HTTPS)
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 4. Get the code onto the VPS

Recommended: push this repo to a **private GitHub repo**, then clone it on the VPS — makes future updates a `git pull` away:
```bash
git clone https://github.com/<you>/fixify-app.git
```

Quicker one-off alternative if you don't want to set up GitHub yet — from your own machine:
```bash
scp -r C:\Users\Admin\Desktop\fixify-app ubuntu@<public-ip>:~/fixify-app
```
(needs `node_modules` excluded first, or just let `npm ci` reinstall on the VPS rather than copying it)

## 5. Configure and launch

On the VPS, inside the `fixify-app` folder:
```bash
cp .env.example .env
nano .env   # set POSTGRES_PASSWORD to something strong; leave PAYMENT_PROVIDER/PAYOUT_PROVIDER unset for now (mock)

docker compose up -d --build
docker compose exec app npm run migrate
docker compose exec app npm run seed
```
Check it's alive: `curl http://localhost:3000/api/health` should return `{"ok":true}`.

## 6. Point Nginx at it

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/fixify
sudo nano /etc/nginx/sites-available/fixify   # replace YOUR_DOMAIN
sudo ln -s /etc/nginx/sites-available/fixify /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 7. Get a domain pointed at it, then HTTPS

Let's Encrypt (via certbot) needs a real domain — it will not issue a certificate for a bare IP address.
- If you don't have a domain yet: register one cheaply (Namecheap, ~$10/yr) or use a free option like [DuckDNS](https://www.duckdns.org/) to get started without spending anything.
- Point the domain's **A record** at your instance's public IP.
- Once DNS has propagated (`dig yourdomain.com` should show your IP):
```bash
sudo certbot --nginx -d yourdomain.com
```
Certbot edits the Nginx config to add the HTTPS server block and sets up auto-renewal (a systemd timer) automatically.

## 8. Verify end to end

Visit `https://yourdomain.com` and run through the driver → vendor → payment flow exactly like you did locally. Check `docker compose logs -f app` on the VPS for the same `[payments:mock]`/`[payouts:mock]` log lines you saw locally.

## 9. Going live with real IntaSend payments later

Once you've registered a business and gotten IntaSend sandbox/live credentials (see README), set the `INTASEND_*` and `PAYMENT_PROVIDER=intasend` / `PAYOUT_PROVIDER=intasend` values in `.env`, point `INTASEND_CALLBACK_URL` / `INTASEND_SENDMONEY_CALLBACK_URL` at `https://yourdomain.com/api/payments/intasend/callback` and `.../api/payouts/intasend/callback`, then:
```bash
docker compose up -d --build app
```

## Operational notes

- **Redeploy after a code change:** `git pull && docker compose up -d --build app`
- **Logs:** `docker compose logs -f app` / `docker compose logs -f db`
- **Backups:** Postgres data lives in the `pgdata` Docker volume. Set up a periodic dump, e.g. a daily cron job running `docker compose exec -T db pg_dump -U fixify fixify > backup-$(date +%F).sql`, copied off the VPS somewhere durable (S3, or even just downloaded periodically) — a pilot with real driver/vendor data losing its only copy on a VPS disk failure is the kind of thing worth 10 minutes to prevent now.
- **Restarts:** `restart: unless-stopped` in `docker-compose.yml` means both containers survive a VPS reboot automatically.
