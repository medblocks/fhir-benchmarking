# FHIR Benchmarking

This repository provides tooling to **benchmark FHIR servers** and compare their performance. It includes infrastructure to run FHIR servers on AWS, scripts to generate and upload synthetic test data, and Locust-based load tests.

**Supported FHIR servers:**

- **HAPI FHIR** — Open-source Java FHIR server with a PostgreSQL backend  
- **Couchbase FHIR CE** — Couchbase-based FHIR implementation  

**Planned:**

- **Medplum** — In progress  

---

## Prerequisites

- **AWS CLI** — Configured with credentials (`aws configure`)
- **Node.js and npm** — For AWS CDK
- **Python 3.x** — For Locust
- **Synthea** — For generating synthetic FHIR test data ([synthea](https://github.com/synthetichealth/synthea))
- **AWS account** — Permissions for EC2, VPC, CloudFormation, SSM, S3

## Project structure

```
fhir-benchmarking/
├── infra/                         # AWS CDK infrastructure
│   ├── bin/
│   │   ├── hapi.ts                # HAPI FHIR stack
│   │   └── couchbase-fhir-vm.ts   # Couchbase FHIR stack
│   └── scripts/                   # Deploy, SSH key, destroy, metrics
├── locust/                        # Load testing
│   ├── hapi_fhir/                 # HAPI scenarios (no auth)
│   │   ├── general.py
│   │   ├── healthcheck.py
│   │   └── pagination.py
│   ├── couchbase/                 # Couchbase scenarios (Bearer token)
│   │   ├── general.py
│   │   ├── healthcheck.py
│   │   └── pagination.py
│   └── requirements.txt
└── synthea-data/                  # Data upload scripts
    ├── upload_hospital_orgs_synthea.sh
    └── upload_patients.sh
```


## 1. Generate Synthea Test Data

Use [Synthea](https://github.com/synthetichealth/synthea) to generate synthetic FHIR R4 data with 1000 patients. Run the following command from the repository root:

```bash
./run_synthea -p 1000 -o synthea-data/
```

This produces the following files inside `synthea-data/`:

- `hospitalInformation*.json` — Organization resources  
- `practitionerInformation*.json` — Practitioner resources  
- Additional `*.json` files — Patient bundles (Patient, Observation, Condition, Encounter, etc.)

---

## 2. AWS CDK Infrastructure

The [infra/](infra/) directory contains AWS CDK stacks that create EC2 instances running FHIR servers and their databases.

### Stacks

1. **HapiStack** — HAPI FHIR + PostgreSQL  
   - VPC with a public subnet  
   - PostgreSQL EC2 (`c6i.xlarge`)
   - HAPI FHIR EC2 (`c6i.xlarge`)
   - CloudWatch log groups  

2. **CouchbaseFhirVMStack** — Couchbase FHIR CE  
   - VPC with public and private subnets  
   - Couchbase EC2 (`c6i.xlarge`)  
   - FHIR server EC2 (`c6i.xlarge`) with HAProxy 
   - CloudWatch log groups  

### Deploy

Use the provided deployment scripts which handle CDK deployment, SSH key retrieval, and display connection information.

**HAPI FHIR:**

```bash
cd infra
npm install
./scripts/deploy-hapi-fhir-vm.sh
```

This script:
- Deploys the HapiStack (HAPI FHIR + PostgreSQL)
- Waits for HAPI FHIR to be ready (up to 15 minutes)
- Fetches the SSH key from SSM Parameter Store
- Copies test files to the Locust instance
- Displays connection info and SSH commands

**Couchbase FHIR:**

```bash
cd infra
npm install
./scripts/deploy-couchbase-fhir-vm.sh
```

This script:
- Deploys the CouchbaseFhirVMStack
- Fetches the SSH key from SSM Parameter Store
- Creates a connection info file at `keys/couchbase-fhir-connection-info.txt`
- Displays instance IPs, URLs, and SSH commands

### Get SSH key (standalone)

If you need to retrieve the SSH key separately (e.g., after a previous deployment), use [infra/scripts/get-ssh-key.sh](infra/scripts/get-ssh-key.sh):

```bash
./infra/scripts/get-ssh-key.sh [HapiStack|CouchbaseFhirVMStack]
```

With no argument, it prompts you to choose a stack. Do not run with `sudo` (AWS credentials are not available there). Keys are saved to `infra/keys/`.

---

## 3. Copy Data and Scripts to EC2

After the stack is deployed and you have the SSH key, copy the upload scripts and Synthea data to the EC2 instance.

```bash
# Copy upload scripts and synthea data to the FHIR server instance
scp -i infra/keys/<key>.pem -r synthea-data/ ec2-user@<FHIR_SERVER_IP>:~/
```

---

## 4. Upload FHIR Data

SSH into the EC2 instance and run the upload scripts.

```bash
ssh -i infra/keys/<key>.pem ec2-user@<FHIR_SERVER_IP>
```

Once connected, run the upload scripts **in order**: hospitals/orgs first, then patients.

### Upload hospital and practitioner data

```bash
cd ~/synthea-data
./upload_hospital_orgs_synthea.sh
```

You will be prompted for:
- FHIR server IP (use `localhost` or the private IP)
- FHIR server port (default: 8080)
- Whether to use bearer token authentication

### Upload patient data

```bash
./upload_patients.sh
```

Same prompts. Patient upload runs in batches (50 files per batch, 10 seconds between batches).

### Authentication

| Server             | Authentication                                                                  |
|--------------------|---------------------------------------------------------------------------------|
| **HAPI FHIR**      | No auth — answer `n` when asked for bearer token                                |
| **Couchbase FHIR** | Bearer token required — set `export FHIR_AUTH_TOKEN="your-token"` before running |

---

## 5. Load Testing with Locust

Load tests run **from your local machine** (or any host that can reach the FHIR server) using [locust/](locust/).

### Setup

```bash
cd locust
python -m venv .venv
pip install -r requirements.txt
source .venv/bin/activate
```

### Test Scenarios

The same scenario types exist for both HAPI FHIR and Couchbase:

| Scenario        | File             | Description                                                                                                   |
|-----------------|------------------|---------------------------------------------------------------------------------------------------------------|
| **General**     | `general.py`     | Mixed FHIR GETs: Patient with `_revinclude` (Observation, DiagnosticReport), search by name, name+birthdate, `GET /Condition` |
| **Healthcheck** | `healthcheck.py` | Sustained load: each user issues 200 requests to `/Patient?_count=10`                                        |
| **Pagination**  | `pagination.py`  | Walk CarePlan result set via `_count=10` and follow `next` links                                              |

### Configure Environment

Each test directory has a `.env.sample` file. Copy it to `.env` and edit with your values:

**HAPI FHIR** (no auth):

```bash
cd locust/hapi_fhir
cp .env.sample .env
# Edit .env: set TARGET_HOST=http://<HAPI_IP>:8080/fhir
```

**Couchbase FHIR** (with auth):

```bash
cd locust/couchbase
cp .env.sample .env
# Edit .env: set TARGET_HOST=http://<FHIR_IP>/fhir and FHIR_BEARER_TOKEN=your-token
```

### Run Locust

Source the `.env` file and run locust:

**HAPI FHIR:**

```bash
cd locust/hapi_fhir
source .env
locust -f general.py
```

Then open the Locust UI at http://localhost:8089, or run headless (see below).

**Couchbase FHIR:**

```bash
cd locust/couchbase
source .env
locust -f general.py
```

**Headless mode example:**

```bash
source .env
locust --host=$TARGET_HOST -f general.py --headless -u 100 -r 10 --run-time 5m
```

For healthcheck and pagination, swap `-f` to `healthcheck.py` or `pagination.py`:

---

## Additional scripts

| Script | Purpose |
|--------|---------|
| [infra/scripts/download-metrics.sh](infra/scripts/download-metrics.sh) | Download CloudWatch metrics for analysis |

---
