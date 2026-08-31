# Azure deployment runbook

Deploys the Agent Ecosystem dashboard as a public demo on Azure Container Apps, free tier.

**What gets deployed:** the dashboard and API, running a synthetic demo dataset. Real agent runs stay on the local machine. Nothing here costs per-token API money.

**Prerequisites:** a GitHub account, and the Azure CLI (`winget install Microsoft.AzureCLI`). Docker is *not* required locally — GitHub Actions builds the image.

---

## 0. Account and credits

Check **Azure for Students** first: https://azure.microsoft.com/free/students — $100 credit, no credit card, if the Wayne State address still verifies. Otherwise use the standard free account (https://azure.microsoft.com/free) which gives $200 for 30 days plus a set of always-free services.

```bash
az login
az account show --query "{subscription:name, id:id}" -o table
```

## 1. Resource group

```bash
az group create --name rg-agent-ecosystem --location eastus
```

## 2. Budget alert — do this before creating anything else

Portal → Cost Management → Budgets → Add. Scope the resource group, amount **$20**, monthly, alert at 50% and 90% to your email. This is the difference between a misconfiguration costing pennies and costing a lot.

## 3. Push the repo to GitHub (public)

Confirm first that nothing private is tracked:

```bash
cd ~/Desktop/AI_Agent
git status --short
git ls-files | grep -Ei "jobhunt|research|resume|\.pdf" \
  && echo "STOP — private files are still tracked; untrack them before continuing" \
  || echo "clean — nothing private tracked"
```

`research/` was tracked in earlier commits and has been untracked, but **it remains in git history**. For a public repo, push a fresh history rather than the existing one.

The orphan branch must be named **`main`** — that is what `.github/workflows/deploy.yml` triggers on. Naming it anything else means no CI runs, no image is built, and nothing tells you.

```bash
# from a clean working tree
git checkout --orphan main
git add -A
git commit -m "Agent Ecosystem: AI agent orchestration with a human approval gate"

# Destroy the old history LOCALLY before adding a remote. Without this the old
# commits are still in the repo, and a later `git push --all` or `--mirror`
# republishes research/ without warning.
git branch -D master
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# verify nothing private survives
git log --all --name-only --pretty=format: | sort -u | grep -Ei "jobhunt|research|resume|\.pdf" \
  && echo "STOP — private files still in history" || echo "history clean"

gh repo create agent-ecosystem --public --source=. --push
```

(Or keep the existing history and make the repo **private** — but then it stops being a portfolio artifact a recruiter can read, which was the point.)

## 4. Let CI build the image

The push triggers `.github/workflows/deploy.yml`, which runs the tests, builds the image locally, **smoke-tests it (health, dashboard, static allowlist, write auth, demo flag, synthetic seed), and only then pushes** to `ghcr.io/<you>/agent-ecosystem`. A failed smoke test means no image is published at all, so there is never a broken `:latest` for Azure to pull. **Wait for this to go green before touching Azure** — it is the Dockerfile's first real validation.

Then make the package public so Azure can pull it without credentials: GitHub → your profile → Packages → `agent-ecosystem` → Package settings → Change visibility → Public.

## 5. Create the Container Apps environment

```bash
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights

az containerapp env create \
  --name env-agent-ecosystem \
  --resource-group rg-agent-ecosystem \
  --location eastus
```

## 6. Deploy the app

Generate a token first and keep it somewhere safe — it is what gates writes:

```bash
# any long random string
TOKEN=$(openssl rand -hex 24); echo "$TOKEN"

az containerapp create \
  --name agent-ecosystem \
  --resource-group rg-agent-ecosystem \
  --environment env-agent-ecosystem \
  --image ghcr.io/<YOUR-GH-USERNAME>/agent-ecosystem:latest \
  --target-port 4242 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 1 \
  --secrets ecosys-token="$TOKEN" \
  --env-vars ECOSYS_BIND=0.0.0.0 ECOSYS_PORT=4242 ECOSYS_TOKEN=secretref:ecosys-token \
  --query properties.configuration.ingress.fqdn -o tsv
```

**`--min-replicas 1 --max-replicas 1` is not optional.** Two replicas means two writers appending to the same event log. Zero replicas means a visitor's first request cold-starts, the dashboard's initial fetch can fail, and the page silently falls back to SIMULATION mode showing mock data — the worst possible first impression on a link you put on a résumé.

## 7. Verify

```bash
URL=https://<fqdn-from-step-6>
curl -s "$URL/healthz"                                    # ok
curl -s -o /dev/null -w "%{http_code}\n" "$URL/"          # 200
curl -s -o /dev/null -w "%{http_code}\n" "$URL/CLAUDE.md" # 404 — allowlist holds
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/api/events"   # 401 — writes gated
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL/api/events" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"agent":"SYS","text":"deploy verification"}'       # 200
```

Then open `$URL` in a browser: badge reads **MODE: LIVE**, the map shows all nine agents, the feed shows the synthetic run history, and the queue holds four demo drafts. Confirm the drafts name Contoso/Northwind/Adventure Works and **no real people** — if you ever see a real name there, the wrong dataset shipped.

## 8. Turn on continuous deployment

Create a service principal and store it as the `AZURE_CREDENTIALS` repo secret:

```bash
az ad sp create-for-rbac --name agent-ecosystem-deploy \
  --role contributor \
  --scopes /subscriptions/<SUB-ID>/resourceGroups/rg-agent-ecosystem \
  --json-auth
```

Paste the JSON into GitHub → Settings → Secrets → Actions → `AZURE_CREDENTIALS`. Then in `.github/workflows/deploy.yml`, change the `deploy` job's `if: false` to `if: github.ref == 'refs/heads/main'`.

## 9. The scheduled job

`agents/digest.js` computes pipeline analytics in plain code — no LLM call, so a nightly cron costs nothing.

**`ECOSYS_REMOTE_URL` is mandatory here, not optional.** The job runs in its own container with its own empty filesystem. Without it the digest would read a blank local event log and post "the pipeline is idle" to your public demo every morning. With it set, the job READS the app's `/api/events` and `/api/drafts` over HTTP, computes the summary, and POSTs the result back — so the app stays the single writer on its event log, and dedupe works off the log itself rather than a state file that an ephemeral container would lose.

```bash
az containerapp job create \
  --name agent-ecosystem-digest \
  --resource-group rg-agent-ecosystem \
  --environment env-agent-ecosystem \
  --trigger-type Schedule \
  --cron-expression "0 7 * * *" \
  --image ghcr.io/<YOUR-GH-USERNAME>/agent-ecosystem:latest \
  --replica-timeout 300 \
  --secrets ecosys-token="$TOKEN" \
  --env-vars ECOSYS_REMOTE_URL=https://<fqdn> ECOSYS_TOKEN=secretref:ecosys-token \
  --command "node" "agents/digest.js"
```

The job POSTs its digest to the app's `/api/events` rather than writing to storage, which keeps exactly one writer on the event log.

---

## Teardown

```bash
az group delete --name rg-agent-ecosystem --yes --no-wait
```

Everything lives in that one resource group, so this removes all of it.

## Cost expectations

Container Apps consumption pricing includes a monthly free grant that a single always-on small replica largely sits inside; GHCR is free for public images; there is no registry, database, or storage account in this design. Expect roughly $0-5/month, comfortably inside the free credit while learning. **The budget alert from step 2 is what makes that guarantee real** — set it.
