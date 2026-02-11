"""
General FHIR GET queries for performance testing.

Usage:
    locust -f general.py --host $TARGET_HOST

    # With Bearer token auth:
    FHIR_BEARER_TOKEN=your_token locust -f general.py --host $TARGET_HOST
"""

import os

from locust import HttpUser, task, between


# Bearer token for authentication (optional)
BEARER_TOKEN = os.environ.get("FHIR_BEARER_TOKEN", "")


class GeneralFHIRUser(HttpUser):
    """
    User that performs various FHIR GET queries.
    Each task has equal weight (1), simulating different query patterns.
    """
    wait_time = between(1, 3)
    
    # Common headers for FHIR requests
    headers = {
        "Accept": "application/fhir+json",
        "Content-Type": "application/fhir+json"
    }
    
    # Add Bearer token if configured
    if BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {BEARER_TOKEN}"

    @task(1)
    def patient_revinclude_observations(self):
        """Task 1: Patient with Observations (revinclude)"""
        self.client.get(
            "/Patient?identifier=4a9f4b68-6c19-8efd-ab04-e6cd02848f50&_revinclude=Observation:subject",
            headers=self.headers,
            name="Patient + revinclude observations"
        )

    @task(1)
    def patient_revinclude_observations_diagnosticreport(self):
        """Task 2: Patient with Observations and DiagnosticReports"""
        self.client.get(
            "/Patient?identifier=4a9f4b68-6c19-8efd-ab04-e6cd02848f50&_revinclude=Observation:subject&_revinclude=DiagnosticReport:patient",
            headers=self.headers,
            name="Patient + revinclude observations, diagnosticreport"
        )

    @task(1)
    def patient_by_name(self):
        """Task 3: Patient by name"""
        self.client.get(
            "/Patient?name=Felisa186",
            headers=self.headers,
            name="Patient by name"
        )

    @task(1)
    def patients_by_name_and_birthday(self):
        """Task 4: Patients by name and birthday"""
        self.client.get(
            "/Patient?name=Fabian647&birthdate=ge1970-01-01",
            headers=self.headers,
            name="Patients by name and birthday"
        )

    @task(1)
    def all_conditions(self):
        """Task 5: All Conditions"""
        self.client.get(
            "/Condition",
            headers=self.headers,
            name="All Conditions"
        )
