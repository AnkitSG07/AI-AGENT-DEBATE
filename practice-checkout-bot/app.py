from flask import Flask, render_template, request, jsonify
import threading
import uuid
from bot import run_checkout_bot, JOBS

app = Flask(__name__)

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/start", methods=["POST"])
def start_bot():
    data = request.json
    job_id = str(uuid.uuid4())[:8]

    JOBS[job_id] = {"status": "running", "logs": [], "result": None}

    config = {
        "url": data.get("url", "https://www.saucedemo.com"),
        "username": data.get("username", "standard_user"),
        "password": data.get("password", "secret_sauce"),
        "product": data.get("product", "Sauce Labs Backpack"),
        "first_name": data.get("first_name", "John"),
        "last_name": data.get("last_name", "Doe"),
        "zip_code": data.get("zip_code", "12345"),
    }

    thread = threading.Thread(target=run_checkout_bot, args=(job_id, config), daemon=True)
    thread.start()

    return jsonify({"job_id": job_id})

@app.route("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
