"""
Pagination test for FHIR CarePlan resources.

Usage:
    locust --host=http://localhost:4080 --locustfile=pagination.py --headless -u 100 -r 100 --run-time 5m

Modern Locust version converted from legacy script.
"""

from urllib.parse import urlparse

from locust import HttpUser, task, between, events
from locust.exception import StopUser


class PaginationUser(HttpUser):
    """
    User that pages through CarePlan results.
    Each user fetches paginated CarePlan resources until no more pages are available.
    """
    wait_time = between(0, 1)  # Equivalent to min_wait=0, max_wait=1000ms
    
    def _get_base_path(self):
        """
        Get the base path from the host URL.
        e.g., http://65.2.177.140:8080/fhir -> /fhir
        """
        parsed = urlparse(self.host)
        return parsed.path.rstrip('/')
    
    def _extract_relative_path(self, url):
        """
        Extract path and query string from a full URL, making it relative to the host's base path.
        
        FHIR servers return full URLs with potentially different host (e.g., 0.0.0.0:8080)
        but we need to use our actual TARGET_HOST. Also, if the host includes a base path
        (like /fhir), we need to strip that from the URL's path to avoid duplication.
        
        Example:
            Host: http://65.2.177.140:8080/fhir (base_path = /fhir)
            URL:  http://0.0.0.0:8080/fhir?_getpages=abc
            Result: ?_getpages=abc (so final request is to /fhir?_getpages=abc)
        """
        parsed = urlparse(url)
        path = parsed.path
        base_path = self._get_base_path()
        
        # Strip the base path from the URL's path if it matches
        if base_path and path.startswith(base_path):
            path = path[len(base_path):]
        
        # Ensure path starts with / if it has content, or is empty for query-only
        if path and not path.startswith('/'):
            path = '/' + path
        
        # Append query string if present
        if parsed.query:
            if path:
                return f"{path}?{parsed.query}"
            else:
                return f"?{parsed.query}"
        
        return path if path else "/"
    
    def _get_next_link(self, data):
        """Extract the 'next' link from FHIR Bundle response."""
        links = data.get('link', [])
        for link in links:
            if link.get('relation') == 'next':
                print(f"Next link: {link['url']}")
                return self._extract_relative_path(link['url'])
        return None
    
    def on_start(self):
        """Initialize user by fetching the first page and getting the next link."""
        self.next_link = None
        
        response = self.client.get("/CarePlan?_count=10", name="/CarePlan?_count=10")
        if response.status_code == 200:
            data = response.json()
            self.next_link = self._get_next_link(data)

    @task
    def process_pages(self):
        """Iterate through paginated CarePlan responses."""
        if not self.next_link:
            raise StopUser()
        
        response = self.client.get(
            self.next_link,
            name="(pagination) Iterate thru /CarePlan response (10 items per)"
        )
        
        if response.status_code == 200:
            data = response.json()
            self.next_link = self._get_next_link(data)
            
            if not self.next_link:
                # No more pages, stop this user
                print("No more pages, stopping user")
                raise StopUser()

        else:
            # Request failed, stop this user
            raise StopUser()


# Optional: Event listeners for custom reporting

@events.spawning_complete.add_listener
def on_spawning_complete(user_count):
    """
    Called when all users have been spawned.
    Replaces the old hatch_complete event.
    """
    print(f"Spawning complete: {user_count} users spawned")


@events.quitting.add_listener
def on_quitting(environment, **kwargs):
    """
    Called when Locust is quitting.
    Use for cleanup or final reporting.
    """
    print("Test complete, quitting...")
