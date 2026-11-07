from fastapi import FastAPI

app = FastAPI(title="Inventory")


@app.post("/api/v1/login/access-token")
def login_access_token():
    return {"access_token": "", "token_type": "bearer"}


@app.get("/api/v1/users/me")
def read_user_me():
    return {}


@app.post("/api/v1/users/signup")
def register_user():
    return {}


@app.get("/api/v1/items/")
def read_items(skip: int = 0, limit: int = 100):
    return {"data": [], "count": 0}


@app.post("/api/v1/items/")
def create_item():
    return {}


@app.delete("/api/v1/items/{id}")
def delete_item(id: str):
    return {"message": "Item deleted successfully"}
