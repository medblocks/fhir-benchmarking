"""
Health check / sustained load test for HAPI FHIR server.

This test creates users that each make 200 requests to /Patient?_count=10,
simulating sustained load over a period of time.

Usage:
    locust -f metadata.py --host $TARGET_HOST

    # With Bearer token auth:
    FHIR_BEARER_TOKEN=your_token locust -f metadata.py --host $TARGET_HOST
"""

import os

from locust import HttpUser, task, between, events


# Bearer token for authentication (optional)
BEARER_TOKEN = os.environ.get("FHIR_BEARER_TOKEN", "")


class MetadataUser(HttpUser):
    """
    User that performs repeated Patient queries for health check / sustained load testing.
    Each user makes multiple requests to simulate sustained activity.
    """
    wait_time = between(1, 2)
    
    # Common headers for FHIR requests
    headers = {
        "Accept": "application/fhir+json",
        "Content-Type": "application/fhir+json"
    }
    
    # Add Bearer token if configured
    if BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {BEARER_TOKEN}"
    
    def on_start(self):
        """Initialize request counter for this user."""
        self.request_count = 0
        self.max_requests = 200

    @task
    def patient_health_check(self):
        """
        FHIR Patient Health Check.
        Each virtual user keeps making requests up to max_requests.
        """
        if self.request_count >= self.max_requests:
            # User has completed their work, stop making requests
            # but don't raise StopUser to allow graceful handling
            return
        
        self.client.get(
            "/Patient?_count=10",
            headers=self.headers,
            name="FHIR Patient Health Check"
        )
        self.request_count += 1


# Optional: Event listeners for monitoring

@events.spawning_complete.add_listener
def on_spawning_complete(user_count):
    """Called when all users have been spawned."""
    print(f"Spawning complete: {user_count} users spawned")


@events.quitting.add_listener
def on_quitting(environment, **kwargs):
    """Called when Locust is quitting."""
    print("Test complete, quitting...")
