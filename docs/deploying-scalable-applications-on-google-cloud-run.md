# Deploying Scalable Applications on Google Cloud Run

An application that works on a laptop still has to survive a real audience. Traffic goes up, a demo becomes a public link, and someone has to decide where the process runs, how it grows, and what it costs when nobody is using it. Google Cloud Run is a fully managed way to run a container as an HTTPS service. You bring the image. Cloud Run runs it, gives it a URL, and starts or stops instances as requests arrive.

This guide follows that path with a working open-source application, [Demo-Cloud-Run](https://github.com/MentSourceLearning/Demo-Cloud-Run). The service is a short quiz called Explain It. A person answers a question about Cloud Run, an Express server asks Gemini whether the answer is right, and the page moves to the next question. The same service is small enough to read in one sitting and complete enough to show container packaging, Artifact Registry, Cloud Run scaling, and a GitHub Actions deploy that does not store a long-lived Google Cloud key.

The material comes from the AnitaB.org Membership session *Deploying Scalable Applications on Google Cloud Run*.

## Table of Contents

1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Background / Overview](#background--overview)
4. [Technical Requirements](#technical-requirements)
5. [Architecture / Design](#architecture--design)
6. [Implementation / Step-by-Step Guide](#implementation--step-by-step-guide)
7. [Code Examples](#code-examples)
8. [Testing and Verification](#testing-and-verification)
9. [Troubleshooting](#troubleshooting)
10. [Best Practices](#best-practices)
11. [Security Considerations](#security-considerations)
12. [Performance and Scalability](#performance-and-scalability)
13. [Conclusion](#conclusion)
14. [References / Further Reading](#references--further-reading)
15. [Author Bio](#author-bio)

## Introduction

Shipping an application raises a different set of questions from writing it. Where does the process live? What happens when ten teammates become ten thousand visitors? Who patches the server, terminates TLS, and turns capacity back down after the spike?

Cloud Run answers those questions for containerized HTTP services. It is a fully managed compute platform. You deploy a container image. Cloud Run provides HTTPS, starts more copies of that container when demand rises, and can scale the service to zero when demand disappears. You pay for the compute you use. You do not provision a cluster, a virtual machine image, or an always-on server for a service whose traffic is uneven.

That shape fits many services teams are building now, including AI-backed APIs. A quiz, a document summarizer, or a model wrapper may be quiet for hours and then busy for a few minutes. The platform has to absorb that without a person resizing machines in the middle of the demo.

Explain It is the service used here. It is a Node.js application. The browser loads a static page. Each submitted answer is a `POST` to `/api/submit`. The server checks the text, calls the Gemini API, and returns a small JSON body: whether the answer was right, the right answer when it was not, the next question, and a few fields that show which instance did the work. Those extra fields are how you watch scaling with your own eyes.

## Prerequisites

You can read the architecture with no cloud account. To run and deploy the service, you need:

- A Google Cloud project with billing enabled.
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`), already logged in.
- Docker, if you build the image on your machine. GitHub Actions builds it for the automated path.
- Node.js 22 or newer, for the local run.
- A [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key).
- A GitHub repository if you want the Actions deploy. The demo repository is [MentSourceLearning/Demo-Cloud-Run](https://github.com/MentSourceLearning/Demo-Cloud-Run).

Enable the APIs the deploy uses:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  secretmanager.googleapis.com \
  --project=PROJECT_ID
```

Replace `PROJECT_ID` with your own project. The demo workflow uses a project named in that file. Treat every project id, project number, and service account in the samples as belonging to that demo, and substitute your own.

You should be comfortable with a terminal, a `Dockerfile`, and the idea that an environment variable can change how a process starts. You do not need a Kubernetes cluster.

## Background / Overview

### Why a container

A container is a packaged application: code, runtime, libraries, and the command that starts it. A useful picture is a shipping container. The contents change. The outside shape does not. The same package moves from a laptop to a test environment and then to production.

Without that package, the usual failure sounds like “it works on my machine.” One computer has a different Node.js version, or a different system library, and the application behaves differently. A container makes the runtime consistent wherever it is started.

Docker builds the image. Cloud Run runs that image as a service. Cloud Run does not replace the Dockerfile. It consumes the image the Dockerfile produces.

### Why Cloud Run

After the image exists, you still choose a place to run it. Cloud Run is a strong default when the workload is a request/response service and you want Google Cloud to manage the fleet:

- Container-based deployment, so the unit you tested is the unit you ship.
- Automatic scaling, including down to zero instances.
- An HTTPS endpoint on a stable URL.
- Integration with the rest of Google Cloud, including Artifact Registry, Secret Manager, Cloud Logging, and Cloud Monitoring.
- Revisions, so a deploy is a new version and traffic can move or roll back.
- Pay-per-use behavior, so an idle demo does not need an always-on virtual machine.

A container on a virtual machine still leaves you with patching, capacity, and a server that costs money overnight. A Kubernetes cluster is the right tool when you want to operate the platform yourself. Cloud Run sits in between: you own the container and the service settings, and Google operates the machines underneath.

### Services and jobs

Cloud Run has two deployment types.

A **service** is a long-running HTTP application. It waits for requests, answers them, and stays available. Explain It is a service.

A **job** runs a container until a task finishes, then exits. Batch work, a nightly export, or a one-off migration fits a job. Jobs are not scaled by incoming HTTP traffic, and they use instance-based billing for the whole run.

The rest of this guide is about services.

### What you configure, and what you stop operating

Three decisions turn source code into a Cloud Run service:

1. **Containerize.** Write a Dockerfile. The process must listen on the port Cloud Run provides.
2. **Build and push.** Publish the image to Artifact Registry so Cloud Run can pull it.
3. **Configure.** Choose the region, memory, CPU, concurrency, identity, who may invoke the service, and the scaling limits.

Cloud Run then handles instance placement, TLS, and the decision to add or remove instances. You still own application correctness, identity, secrets, and the limits that protect your bill and your downstream APIs.

## Technical Requirements

Explain It is a small Node.js service.

| Requirement | What the demo uses |
| --- | --- |
| Runtime | Node.js 22 (`node:22-slim` in the image, `engines.node` `>=22` in `package.json`) |
| HTTP server | Express 4, started with `tsx src/server.ts` |
| Model API | `@google/genai`, model name from `GEMINI_MODEL` |
| Listen address | `0.0.0.0` and `process.env.PORT`, default `8080` |
| Public paths | `GET /healthz`, `POST /api/submit`, and the static files in `frontend/` |
| Image registry | Artifact Registry, Docker format |
| Deploy target | Cloud Run service, region `us-central1` in the demo workflow |
| Scaling flags in the demo | Minimum instances `0`, maximum instances `3`, startup CPU boost, generation 2 execution environment |

The container contract is the part that makes a deploy succeed or fail:

- The process listens on `0.0.0.0`, not only on `127.0.0.1`. Cloud Run’s proxy is outside the container.
- The process uses the `PORT` environment variable. Cloud Run sets it. The demo image also sets `PORT=8080`, and the deploy command passes `--port 8080`, so the proxy and the process agree.
- The start command is explicit. In this image it is `npm start`.

Local development can use a `backend/.env` file. Cloud Run will not have that file. The API key has to arrive as a service environment variable or, preferably, a Secret Manager secret. `dotenv` does not override variables that are already set, so a key configured on the service is the one the process uses.

## Architecture / Design

### Request path

```text
Browser
  |
  |  HTTPS
  v
Cloud Run service (one container image)
  |
  |-- static files from frontend/     (the quiz page)
  |-- GET  /healthz                    (process is up)
  `-- POST /api/submit                 (grade one answer)
            |
            |  Gemini API, 25 second limit inside the app
            v
         JSON result
            correct, rightAnswer, nextQuestion
            instanceId, requestsHandledByThisInstance
            modelMs, uptimeSeconds, model
```

The browser never calls Gemini. That boundary matters. The page posts the question and the answer. The server validates them, calls the model, and returns a structured result. Later you can change the model, the prompt, or the safety checks without changing the page.

A wrong answer stays on screen for five seconds, then the next question replaces it. A right answer moves on immediately. The question list lives in the server, not in the model. Gemini decides whether the answer is acceptable and, when it is not, writes the correction.

### Deploy path

```text
git push to main
    |
    v
GitHub Actions
    |
    |  OIDC token, no downloaded service-account key
    v
Workload Identity Federation
    |
    v
Deployer service account
    |
    |-- docker push --> Artifact Registry
    `-- gcloud run deploy --> new Cloud Run revision
```

Each push to `main` builds one image tagged with the Git commit, pushes it, and deploys that digest’s tag. A new deploy creates a new revision. The previous revision remains available if you need to send traffic back.

### What one instance knows

Every process picks a short random `instanceId` at startup and counts graded submissions in memory. Those values die when the instance shuts down. They are not a database. They are a window onto scaling: two different `instanceId` values mean two containers did the work.

### An AI service is usually more than one box

A larger AI product is rarely one process. A typical split is a web front end, an authentication service, a document pipeline, a retrieval service, a model API, and a worker for slow jobs. Cloud Run is a good home for the request-driven pieces because each one deploys and scales on its own. Explain It keeps the page and the API in one service so the lesson stays on one URL. The same Dockerfile pattern applies when you later split them.

## Implementation / Step-by-Step Guide

### 1. Run the quiz locally

Clone the repository and install from the `backend` directory:

```bash
git clone https://github.com/MentSourceLearning/Demo-Cloud-Run.git
cd Demo-Cloud-Run/backend
npm install
```

Create `backend/.env`:

```bash
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.8-flash
PORT=8080
```

`GEMINI_MODEL` is optional. The server defaults to `gemini-3.8-flash`. Start the process:

```bash
npm start
```

Open `http://localhost:8080`. The first question is “What happens when Cloud Run scales to zero?” Submit an answer. A correct one is replaced by another question. An incorrect one shows a short correction, waits five seconds, and then moves on.

### 2. Package the service

The image is built from the repository root so one Dockerfile can see both `backend/` and `frontend/`. The root `Dockerfile` is the one the workflow uses.

```dockerfile
FROM node:22-slim

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
COPY frontend /app/frontend

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
```

`npm ci` installs from the lockfile. The start command runs `tsx src/server.ts`, so the image executes TypeScript directly. That keeps the demo easy to follow. A production image can compile first and ship only the JavaScript, in a second stage, if you want a smaller runtime.

Build from the repository root:

```bash
docker build -t explainit:local .
docker run --rm -p 8080:8080 --env-file backend/.env explainit:local
```

`--env-file` puts the key in the container environment. It does not copy `.env` into the image. The repository `.dockerignore` also excludes `.env` files, so a normal `docker build` cannot bake the key into a layer.

### 3. Store the image in Artifact Registry

Create a Docker repository once:

```bash
gcloud artifacts repositories create explainit \
  --repository-format=docker \
  --location=us-central1 \
  --project=PROJECT_ID

gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
```

Tag and push a specific build. A commit SHA, or any unique tag, is easier to roll back than `latest`.

```bash
IMAGE=us-central1-docker.pkg.dev/PROJECT_ID/explainit/explainit
docker build -t "$IMAGE:$(git rev-parse HEAD)" .
docker push "$IMAGE:$(git rev-parse HEAD)"
```

### 4. Put the API key in Secret Manager

The quiz cannot grade answers without `GEMINI_API_KEY`. Keep it out of the image and out of Git.

```bash
printf '%s' 'your_gemini_api_key_here' | gcloud secrets create gemini-api-key \
  --data-file=- \
  --project=PROJECT_ID \
  --replication-policy=automatic
```

Cloud Run’s runtime identity needs permission to read that secret. If you have not set a custom runtime service account, the default is:

`PROJECT_NUMBER-compute@developer.gserviceaccount.com`

```bash
gcloud secrets add-iam-policy-binding gemini-api-key \
  --project=PROJECT_ID \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

A dedicated runtime service account is the better long-term choice. Create one, grant it `roles/secretmanager.secretAccessor` on this secret, and pass it to Cloud Run with `--service-account`. The demo workflow does not set a runtime service account yet.

### 5. Deploy the service

```bash
gcloud run deploy explainit1 \
  --image "$IMAGE:$(git rev-parse HEAD)" \
  --region us-central1 \
  --project PROJECT_ID \
  --port 8080 \
  --min-instances 0 \
  --max-instances 3 \
  --cpu-boost \
  --execution-environment gen2 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --set-env-vars GEMINI_MODEL=gemini-3.8-flash \
  --allow-unauthenticated
```

What those flags do:

| Flag | Effect |
| --- | --- |
| `--port 8080` | Send traffic to the port the process listens on |
| `--min-instances 0` | Allow scale to zero when there is no traffic |
| `--max-instances 3` | Cap the fleet so a spike cannot open an unlimited bill |
| `--cpu-boost` | Give the container extra CPU while it starts, which shortens cold starts |
| `--execution-environment gen2` | Use the second-generation runtime, which has broader Linux compatibility |
| `--set-secrets` | Mount the Gemini key from Secret Manager as `GEMINI_API_KEY` |
| `--allow-unauthenticated` | Let anyone with the URL open the quiz |

The command prints a service URL. That URL is the public demo.

`--allow-unauthenticated` matches a public workshop. For an internal tool, drop that flag and grant `roles/run.invoker` only to the callers who should reach it.

### 6. Let GitHub deploy without a downloaded key

The demo deploys from GitHub Actions with Workload Identity Federation. GitHub presents an OIDC token. Google accepts that token only from a pool and provider you configured, and only for the repository you named. The workflow then borrows a deployer service account for the length of the job. There is no JSON key stored in GitHub.

The session sets this up in two commands. The pool in the demo is named `github-pool`. Create it once if it is not already there:

```bash
gcloud iam workload-identity-pools create github-pool \
  --project=PROJECT_ID \
  --location=global \
  --display-name="GitHub pool"
```

The first command answers “which GitHub repository do we trust?” It adds a GitHub OIDC provider to that pool. Tokens must come from `https://token.actions.githubusercontent.com`, and the token’s repository claim must match yours. The provider also records the repository on the token, which the next command uses.

```bash
gcloud iam workload-identity-pools providers create-oidc github-provider-cloud-run-demo \
  --project=PROJECT_ID \
  --location=global \
  --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='OWNER/REPO'"
```

Replace `OWNER/REPO`. For this demo that value is `MentSourceLearning/Demo-Cloud-Run`. The provider id above is the one the demo workflow already references.

The second command answers “what may that repository do?” It lets that repository assume the deployer service account during an Actions run.

```bash
gcloud iam service-accounts add-iam-policy-binding \
  DEPLOYER_SA@PROJECT_ID.iam.gserviceaccount.com \
  --project=PROJECT_ID \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/OWNER/REPO"
```

The deployer account also needs permission to push images and deploy Cloud Run:

- `roles/artifactregistry.writer` on the repository
- `roles/run.developer` on the project or service, which is enough to deploy. `roles/run.admin` also works and includes permission to delete services and manage IAM on Cloud Run, so leave it for people who administer the project
- `roles/iam.serviceAccountUser` on the runtime service account, so the deploy can attach it

The workflow in the repository is the piece that uses this trust. A push to `main` checks out the code, authenticates with the provider, pushes the image, and deploys. The job requests `id-token: write`. Without that permission, GitHub will not mint the OIDC token Workload Identity needs.

The workflow in the repository deploys the image and the scaling flags. It does not yet pass `--set-secrets`. After the first manual deploy with the secret, later deploys keep existing service settings unless a flag changes them. Add the `--set-secrets` and `--set-env-vars` flags to the workflow when you want every deploy to state the full configuration.

## Code Examples

### The server listens the way Cloud Run expects

`backend/src/server.ts` reads `PORT`, defaults to 8080, and binds every interface:

```ts
const port = Number(process.env.PORT ?? 8080);

app.listen(port, "0.0.0.0", () => {
  console.log(`Open http://localhost:${port}`);
});
```

A process that listens only on `127.0.0.1` starts cleanly and then never receives Cloud Run traffic. Binding `0.0.0.0` is the fix.

### Each instance can identify itself

At startup the process keeps a small amount of local state:

```ts
const instanceId = Math.random().toString(36).slice(2, 8);
const startedAt = Date.now();
let requestCount = 0;
```

`instanceId` stays constant until that process exits. `requestCount` counts graded submissions handled by this process. Neither value is shared across instances. That is what makes them useful. If two responses carry different ids, Cloud Run has started more than one container.

### Grading stays behind the API

`POST /api/submit` trims the question and the answer and rejects empty input. The handler then calls Gemini and returns both the grade and the instance facts:

```ts
res.json({
  correct: graded.correct === true,
  rightAnswer: String(graded.rightAnswer ?? "").trim(),
  nextQuestion: pickNextQuestion(question),
  instanceId,
  requestsHandledByThisInstance: requestCount,
  modelMs: Date.now() - started,
  uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  model,
});
```

The model call itself is bounded. The server aborts it after 25 seconds, asks for a small JSON object, and treats equivalent explanations as correct:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 25_000);
try {
  return await getClient().models.generateContent({
    model,
    contents,
    config: {
      abortSignal: controller.signal,
      systemInstruction:
        "Grade the answer. Treat equivalent explanations as correct. If it is wrong, rightAnswer is the correct answer in at most 3 short sentences. If it is right, rightAnswer is one short sentence stating that answer.",
      maxOutputTokens: 200,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          correct: { type: Type.BOOLEAN },
          rightAnswer: { type: Type.STRING },
        },
        required: ["correct", "rightAnswer"],
      },
    },
  });
} finally {
  clearTimeout(timer);
}
```

The schema is the service boundary. The page does not parse free-form model text. It reads `correct` and `rightAnswer`.

### The page only knows the API

`frontend/app.js` posts to the same origin:

```js
const response = await fetch("/api/submit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question, answer }),
});
```

A right answer calls `showNextQuestion` immediately. A wrong answer writes the correction into the result area, waits 5000 milliseconds, and then advances. The page does not display `instanceId`. Use the browser network panel, or `curl`, when you want to see which instance answered.

### The workflow is the deploy

`.github/workflows/deploy.yml` is the automated path. The deploy step matches the manual command:

```yaml
- name: Deploy to Cloud Run
  run: |
    gcloud run deploy "$SERVICE" \
      --image "$IMAGE:${{ github.sha }}" \
      --region "$REGION" \
      --project "$PROJECT_ID" \
      --port 8080 \
      --min-instances 0 \
      --max-instances 3 \
      --cpu-boost \
      --execution-environment gen2 \
      --allow-unauthenticated \
      --quiet
```

The image tag is `github.sha`. Every deploy points at the commit that produced it.

### Secrets stay out of the build

`.dockerignore` includes:

```text
**/.env
**/.env.*
```

Combined with Secret Manager on the service, the key is present when the process handles a request and absent from the image layers you push.

## Testing and Verification

### Local health

With the server running:

```bash
curl -i http://localhost:8080/healthz
```

A healthy process returns `200` and the body `ok`.

Grade one answer:

```bash
curl -s http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"What happens when Cloud Run scales to zero?\",\"answer\":\"No instances are running, and the next request starts one.\"}"
```

You want JSON with `correct`, `nextQuestion`, `instanceId`, `requestsHandledByThisInstance`, `modelMs`, and `uptimeSeconds`. Submit again. `requestsHandledByThisInstance` should increase. `instanceId` should stay the same, because you are on one local process.

An empty answer returns `400` and does not call the model:

```bash
curl -i http://localhost:8080/api/submit \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"What is a cold start in Cloud Run?\",\"answer\":\"\"}"
```

### After deploy

Replace `SERVICE_URL` with the URL Cloud Run printed.

```bash
curl -i "$SERVICE_URL/healthz"
```

Then submit an answer the same way you did locally. The first request after a quiet period is often slower. That pause is the cold start: Cloud Run pulls the instance into service, starts Node, and only then runs the handler. `uptimeSeconds` near zero and a larger `modelMs` plus wait time are the signs. A second request to the same warm instance is usually quicker, and `uptimeSeconds` has moved on.

### Seeing more than one instance

The demo caps the service at three instances and does not change concurrency. A new Cloud Run service created with the CLI gets a maximum concurrency of 80 requests per instance when the service has one vCPU. One person clicking Submit will stay on one instance.

To watch a second instance, either:

- lower concurrency, for example `gcloud run services update explainit1 --region us-central1 --concurrency 1`, and then send several requests at the same time, or
- send more overlapping requests than the current concurrency allows.

A short parallel check against your own service:

```bash
for n in 1 2 3 4 5 6; do
  curl -s "$SERVICE_URL/api/submit" \
    -H "Content-Type: application/json" \
    -d "{\"question\":\"Why would Cloud Run start more than one instance?\",\"answer\":\"To handle more concurrent requests than the current instances allow.\"}" &
done
wait
```

Compare `instanceId` across the responses. Different ids mean Cloud Run started more than one copy. Identical ids mean those requests shared an instance, which is what concurrency is for.

Raise concurrency again after the experiment if you lowered it only for the demo. Each Gemini call takes noticeable time and holds a request slot until it finishes.

### Questions the service asks

The quiz is also the checklist for this guide. A solid answer sounds like this:

| Question | A sound answer |
| --- | --- |
| What happens when Cloud Run scales to zero? | No instances are running. With the default request-based billing you are not charged for CPU or memory while nothing is up. The next request starts an instance. |
| What is a cold start? | The time Cloud Run spends starting a new instance before it can handle the request. |
| What is the difference between concurrency and max instances? | Concurrency is how many requests one instance may handle at once. Max instances is how many instances the service may run. |
| When does a Cloud Run service stop being billed for CPU? | With request-based billing, CPU is billed while the instance starts, handles a request, or shuts down. Billing for that CPU stops when the instance is idle. At zero instances there is nothing left to bill. |
| What does a request timeout mean? | The longest Cloud Run will wait for a response. The default is 300 seconds. After that, the caller receives HTTP 504. |
| Why would Cloud Run start more than one instance? | Incoming work exceeds what the current instances can take under the concurrency and CPU targets, up to the max-instances cap. |
| What is the difference between a service and a job? | A service answers requests and stays deployed. A job runs a task to completion and exits. |
| What happens to in-flight requests when an instance shuts down? | New requests go to other instances. Cloud Run sends `SIGTERM`, waits 10 seconds, then sends `SIGKILL`. In-flight work should finish or exit during that window. |

## Troubleshooting

**The page loads, and every submit returns 502.**  
The JSON error often says to set `GEMINI_API_KEY` in `backend/.env`. Locally, create that file. On Cloud Run, there is no `.env`. Attach the secret with `--set-secrets` and confirm the runtime service account has `roles/secretmanager.secretAccessor`. The handler also surfaces Gemini status and code when the API returns an error body, which covers a bad key, a disabled API, or an unknown model name.

**The submit spinner ends with “Gemini took too long.”**  
The server aborts the model call at 25 seconds. Submit again. If it persists, check Gemini status and whether the model name in `GEMINI_MODEL` is valid. This abort is inside the app. It is separate from the Cloud Run request timeout, which defaults to 300 seconds.

**The container starts and the URL returns 503.**  
The process is not accepting traffic on `PORT`. Confirm the log line from `app.listen`, confirm the image was built from the repository root, and confirm `--port` matches `ENV PORT`. Building with `backend/` as the Docker context fails or produces the wrong layout, because the Dockerfile copies `backend/package.json` and `frontend/` from the root context.

**Docker push or `gcloud run deploy` says Permission denied in GitHub Actions.**  
The job authenticated as a different identity than you expect. Check the provider attribute condition, the `workloadIdentityUser` binding, and that `OWNER/REPO` matches the repository that ran the workflow. The job also needs `permissions: id-token: write`.

**The service URL returns 403.**  
The service is private. Either the caller needs `roles/run.invoker`, or you intentionally want `--allow-unauthenticated` for a public quiz.

**Traffic spikes return 429.**  
The service is at `max-instances`, or a quota is exhausted. The demo cap is 3. Raise it only after you know the Gemini quota and the bill can absorb the extra instances.

**A deploy looks fine and the quiz still runs old code.**  
Cloud Run serves a revision. Confirm the new revision has 100 percent of the traffic and that its image tag is the commit you just pushed. Sending traffic back to the previous revision is the rollback.

**Logs show the answer text.**  
This application does not log the submitted answer. If you add logs, log the status, the instance id, and `modelMs`. Leave the answer and the API key out of the log line.

## Best Practices

**Listen to the platform.** Read `PORT`, bind `0.0.0.0`, and keep the start command in the image. Do not assume a laptop port or a localhost-only server.

**Tag images by commit.** `latest` hides which build is running. The demo tag is the Git SHA, so a revision points at a known commit.

**State scaling limits on purpose.** `--max-instances 3` is a product decision. It protects a database, a model quota, and the bill. Pick the number from the downstream limit, not from a hope that traffic will stay small.

**Choose concurrency from a test, not from a slogan.** More concurrency uses an instance more fully when requests spend time waiting on the network. Less concurrency isolates heavy work. Explain It’s model call holds the request open, so a high concurrency multiplies overlapping Gemini calls on one instance. Measure CPU, memory, and `modelMs` before you lock the value in.

**Keep secrets in Secret Manager.** `.dockerignore` keeps `.env` out of the image. The service reads the key from the environment Cloud Run injects. Rotate the secret by adding a new version. Cloud Run’s `latest` alias picks it up on the next instance.

**Use a deployer identity and a runtime identity.** The GitHub workflow borrows a deployer account. The running quiz should use a different service account whose only extra permission is to read the Gemini secret.

**Treat a deploy as a revision.** Watch the new revision with a slice of traffic when the change is risky, then move the rest. Roll back by moving traffic, not by rebuilding in a hurry.

**Observe the service before you call it finished.** Cloud Logging shows application and platform logs. Cloud Monitoring shows request count, latency, errors, and resource use. Trace a request when more than one service is on the path. Error reporting groups repeated failures. The fields this API already returns (`instanceId`, `modelMs`, `uptimeSeconds`) are the application-level version of that habit.

**Delete experiments.** An unused service with minimum instances above zero, or a forgotten image, still has a cost. Remove services you no longer demo.

## Security Considerations

Cloud Run removes a lot of infrastructure work. It does not choose your threat model.

**Public or private is a product decision.** The demo is public because a workshop audience needs the URL. An internal API should require authentication. Drop `--allow-unauthenticated` and grant `roles/run.invoker` to specific users or service accounts. Put user login in the application if people, rather than other services, are the callers.

**Least privilege on both identities.** The deployer account pushes images and updates Cloud Run. The runtime account reads the Gemini secret. Neither account needs to be a project owner. The Workload Identity binding is limited to one repository through `attribute.repository` and the provider’s attribute condition.

**The key never belongs in Git or in an image layer.** `backend/.env` is a local file. `.gitignore` and `.dockerignore` both exclude it. Secret Manager is the source for the deployed service.

**Validate input before you pay for a model call.** The handler rejects an empty question or answer, caps each field at 500 characters, and limits JSON bodies to 16 KB. That will not stop abuse by itself. It does stop accidental empty traffic from calling Gemini.

**The browser does not hold the Gemini key.** The page calls `/api/submit` on the same origin. Keep it that way. A key in frontend JavaScript is a published key.

**CORS is open.** `cors()` with no origin list accepts any origin. Same-origin use from the quiz page does not need that. Restrict allowed origins if a browser on another site should not call the API.

**Log the operation, not the content.** Answers, prompts, and keys do not belong in logs. For a production AI endpoint, add authentication, rate limits, request timeouts, and a review of what the model is allowed to see.

**Handle shutdown.** On the generation 2 execution environment the demo selects, trap `SIGTERM` if you need a clean moment to finish or abandon in-flight model calls. Cloud Run waits 10 seconds after `SIGTERM`, then sends `SIGKILL`.

## Performance and Scalability

### Scale to zero and cold starts

`--min-instances 0` means a quiet service runs nothing. The next request creates an instance. That delay is a cold start: schedule the instance, start the container, start Node, and accept the connection.

Startup CPU boost, `--cpu-boost`, raises CPU during startup so the process reaches “ready” sooner. You can also set `--min-instances 1` when the first user of the day must not pay the cold start. Those warm instances are billed even when idle, and a minimum instance count belongs with instance-based billing if you need CPU outside a request. The demo keeps the default, request-based billing, and allows scale to zero. That is the right trade for a workshop quiz.

### Concurrency and max instances

Think of a dining room. One table serves several people at once. That is concurrency. Opening another room is a new instance. You do both, for different reasons.

- **Concurrency** limits simultaneous requests on one instance. The CLI default for a new service is 80 per vCPU, up to 1000. Cloud Run may send fewer than that when CPU is already busy.
- **Max instances** limits how many rooms you will open. The demo uses 3.
- **Min instances** is how many rooms you keep staffed overnight. The demo uses 0.

Cloud Run adds instances when concurrency or CPU crosses its targets, and it will not pass the maximum. If every instance is busy and the cap is reached, extra requests are rejected.

There is no universal “more concurrency is better.” A text quiz that waits on Gemini can share an instance. A memory-heavy model or an image pipeline often wants a lower concurrency so two heavy requests do not compete. Change the setting, send real traffic, and read latency and memory before you keep it.

### Timeouts

Two clocks run on each grading request:

- The application aborts the Gemini call at 25 seconds and returns a clear error.
- Cloud Run closes the HTTP connection at the request timeout. The default is 300 seconds, and the maximum is 3600 seconds. The caller sees HTTP 504.

Closing the connection does not always stop the process from continuing work. Keep the application timeout shorter than the Cloud Run timeout, as this server does, so the instance is released on purpose.

### When CPU billing stops

Request-based billing, the default, charges CPU while an instance is starting, handling at least one request, or shutting down. When the instance is idle, CPU is throttled and that CPU charge stops. When the service scales to zero, there is no instance to bill.

Instance-based billing charges for the whole life of the instance, including idle time. Use it when the process must do work with no request in flight, or when you keep minimum instances and need CPU between requests. Cloud Run jobs always use instance-based billing.

An AI request is a poor candidate for “one request costs the same as any other.” One quiz answer calls a model. Another product’s request might upload a file, query a database, and call a larger model. Max instances, concurrency, and quotas are how you keep a spike from becoming an unbounded invoice.

### Revisions

Every `gcloud run deploy` creates a revision. You can split traffic, try a revision, and move traffic back. Combine that with the metrics above. A revision that raises `modelMs` or error rate is a rollback, not a mystery.

## Conclusion

Cloud Run is a practical way to take a container from a laptop to an HTTPS service that grows and shrinks with traffic. The work you still do is the work that matters: a Dockerfile that listens on `PORT`, an image in Artifact Registry, a service account with a narrow role, a secret that is not in Git, and scaling limits you chose on purpose.

Explain It is one AI-shaped service on that path. The page stays simple. The model stays behind `/api/submit`. The response tells you which instance answered, how long the model took, and how long that instance has been alive. Those are enough to see a cold start, a warm instance, and a second instance when you ask for one.

### Cloud Run or GKE: which is the best?

A participant asked, “Google Cloud Run and GKE, which is the best?”

There is no single winner. Each one is the best choice for a different job.

**Cloud Run is the best fit for a stateless request/response service** like Explain It. You bring a container. Google Cloud provides the HTTPS URL, starts and stops instances, and can scale the service to zero. You set region, memory, concurrency, identity, and a max instance count. You do not run a cluster, upgrade nodes, or write Kubernetes manifests. That is the right trade when the application is an API, a web service, or an AI endpoint with uneven traffic, and the team wants to spend its time on the product.

**Google Kubernetes Engine (GKE) is the best fit when the thing you need is Kubernetes.** Choose GKE when the workload depends on the Kubernetes API: many services scheduled together, StatefulSets, DaemonSets, custom controllers, a service mesh, network policy you operate yourself, or node pools you tune for GPUs and special hardware. GKE manages the control plane. Your team still owns manifests, node pools, upgrades, and cluster cost, including capacity that stays up when traffic does not.

Use the application as the test. If it is an HTTP container with a clear start command and a port, start on Cloud Run. Move to GKE when a real requirement shows up that Cloud Run cannot express. Starting on GKE “in case we need it later” means operating a cluster before the product needs one.

The point of scaling is not only to survive more traffic. A service that grows should stay understandable, observable, secure, and cost-conscious. Cloud Run will start the instances. The limits, the identity, and the logs are still yours.

## References / Further Reading

- [Demo-Cloud-Run source](https://github.com/MentSourceLearning/Demo-Cloud-Run), the Explain It service used in this guide
- [Cloud Run overview](https://cloud.google.com/run/docs)
- [Container runtime contract](https://cloud.google.com/run/docs/container-contract), including `PORT`, `SIGTERM`, and the 10 second shutdown window
- [Instance autoscaling](https://cloud.google.com/run/docs/about-instance-autoscaling)
- [Maximum concurrent requests](https://cloud.google.com/run/docs/about-concurrency)
- [Request timeout](https://cloud.google.com/run/docs/configuring/request-timeout)
- [Billing settings](https://cloud.google.com/run/docs/configuring/billing-settings)
- [Startup CPU boost](https://cloud.google.com/run/docs/configuring/cpu)
- [Workload Identity Federation with deployment pipelines](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [google-github-actions/auth](https://github.com/google-github-actions/auth)
- [Artifact Registry Docker quickstart](https://cloud.google.com/artifact-registry/docs/docker/quickstart)
- [Secret Manager](https://cloud.google.com/secret-manager/docs)
- [Gemini API](https://ai.google.dev/gemini-api/docs)

## Author Bio

Peculiar C. Umeh is a software developer, technical project manager, and open source advocate. She also works as a program and community manager. While managing a cloud project at JKA Consulting, whose team delivers DevOps as a service, she used an AnitaB.org Pluralsight package to study the Google Cloud leader material and Google Cloud Run. This guide was born from her AnitaB.org Membership session, Deploying Scalable Applications on Google Cloud Run, held on 8 October 2026. The session is listed on the [AnitaB.org event page](https://membership-app.anitab.org/flow/anitab/membership/eventcatalog/page/eventcatalogunauth/session/1787344688746001mXUa?utm_source=MarketingCloud&utm_medium=email&utm_campaign=9.28.26%2BMembership-Deploying%2BScalable%2BApps%2BEvent%2BEmail&utm_content=Deploying%2BScalable%2BApplications%2Bon%2BGoogle%2BCloud%2BRun&utm_term=+1267).
