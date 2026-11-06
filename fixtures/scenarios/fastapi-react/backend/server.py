from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from agent_framework.ag_ui import add_agent_framework_fastapi_endpoint


def create_app(agent, admin_app) -> FastAPI:
    app = FastAPI()

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/auth/callback")
    def callback(code: str):
        """The identity provider redirects the browser here after sign-in."""

    @app.get("/api/auth/session")
    def session():
        ...

    @app.post("/api/auth/logout")
    def logout():
        ...

    @app.get("/api/reports")
    def reports():
        ...

    @app.get("/api/reports/{filename:path}")
    def report(filename: str):
        ...

    @app.post("/api/reports/run")
    def run():
        ...

    @app.get("/api/dashboard/summary")
    def summary():
        ...

    @app.get("/api/templates/{name}")
    def template(name: str):
        ...

    @app.put("/api/templates/{name}")
    def save_template(name: str):
        ...

    @app.get("/api/templates/{name}/raw")
    def template_raw(name: str):
        ...

    @app.delete("/api/exports/{workspace_id}/{timestamp}")
    def delete_export(workspace_id: str, timestamp: str):
        ...

    # The library helper always registers POST at the path it is given.
    add_agent_framework_fastapi_endpoint(app, agent, "/api/chat")

    app.mount("/api/downloads", StaticFiles(directory="exports"), name="downloads")
    app.mount("/admin", admin_app)
    return app
