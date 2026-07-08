from playwright.sync_api import sync_playwright
import traceback

JOBS = {}  # in-memory job store

def log(job_id, message):
    print(f"[{job_id}] {message}")
    JOBS[job_id]["logs"].append(message)

def run_checkout_bot(job_id, config):
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            page = browser.new_page()

            # Block heavy resources for speed
            page.route(
                "**/*.{png,jpg,jpeg,woff,woff2,svg}",
                lambda route: route.abort(),
            )

            # 1. Login
            log(job_id, "🔐 Logging in...")
            page.goto(config["url"], timeout=30000)
            page.fill("#user-name", config["username"])
            page.fill("#password", config["password"])
            page.click("#login-button")

            if page.locator("[data-test='error']").count() > 0:
                raise Exception("Login failed: " + page.text_content("[data-test='error']"))
            log(job_id, "✅ Login successful")

            # 2. Add product to cart
            log(job_id, f"🛒 Adding '{config['product']}' to cart...")
            item = page.locator(".inventory_item", has_text=config["product"])
            if item.count() == 0:
                raise Exception(f"Product '{config['product']}' not found")
            item.locator("button", has_text="Add to cart").click()
            log(job_id, "✅ Added to cart")

            # 3. Checkout
            log(job_id, "💳 Proceeding to checkout...")
            page.click(".shopping_cart_link")
            page.click("#checkout")

            # 4. Shipping info
            log(job_id, "📦 Filling shipping details...")
            page.fill("#first-name", config["first_name"])
            page.fill("#last-name", config["last_name"])
            page.fill("#postal-code", config["zip_code"])
            page.click("#continue")

            # 5. Finish order
            page.click("#finish")

            # 6. Confirm
            confirmation = page.text_content(".complete-header")
            log(job_id, f"🎉 Order complete: {confirmation}")

            JOBS[job_id]["status"] = "completed"
            JOBS[job_id]["result"] = confirmation
            browser.close()

    except Exception as e:
        log(job_id, f"❌ Error: {str(e)}")
        JOBS[job_id]["status"] = "failed"
        JOBS[job_id]["result"] = str(e)
        traceback.print_exc()
