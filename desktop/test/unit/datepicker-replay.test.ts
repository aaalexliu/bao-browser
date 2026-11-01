// A react-datepicker year jump is a month/year select, not 24 next clicks.
// An editable text date field is filled with the resolved date.

import assert from "node:assert/strict";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { BrowserDriver } from "../../src/v1/browser-driver";

const html = `<!doctype html>
<input id="dob" readonly value="22 Oct 2026">
<div class="react-datepicker" hidden>
  <select class="react-datepicker__month-select"></select>
  <select class="react-datepicker__year-select"></select>
  <div class="react-datepicker__current-month">October 2026</div>
  <div class="react-datepicker__month"></div>
</div>
<p id="chosen"></p>
<script>
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const month = document.querySelector(".react-datepicker__month-select");
  const year = document.querySelector(".react-datepicker__year-select");
  months.forEach((name, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    month.appendChild(option);
  });
  for (let y = 1980; y <= 2030; y++) {
    const option = document.createElement("option");
    option.value = String(y);
    option.textContent = String(y);
    year.appendChild(option);
  }
  month.value = "9";
  year.value = "2026";
  const popup = document.querySelector(".react-datepicker");
  const render = () => {
    const m = Number(month.value);
    const y = Number(year.value);
    document.querySelector(".react-datepicker__current-month").textContent = months[m] + " " + y;
    const grid = document.querySelector(".react-datepicker__month");
    grid.innerHTML = "";
    const day = document.createElement("div");
    day.className = "react-datepicker__day";
    day.textContent = "15";
    day.setAttribute("aria-label", "Choose Monday, " + months[m] + " 15th, " + y);
    day.addEventListener("click", () => {
      const iso = y + "-" + String(m + 1).padStart(2, "0") + "-15";
      document.querySelector("#chosen").textContent = iso;
      document.querySelector("#dob").value = iso;
    });
    grid.appendChild(day);
  };
  month.addEventListener("change", render);
  year.addEventListener("change", render);
  document.querySelector("#dob").addEventListener("click", () => { popup.hidden = false; render(); });
  render();
</script>`;

test("pickDate uses the month and year selects for a far date of birth", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const driver = new BrowserDriver(page);
    await driver.pickDate({
      iso: "1990-01-15",
      formatted: "1990-01-15",
      node: { surface: "dom", role: "textbox", tag: "input", id: "dob", path: [] },
    });
    assert.equal(await page.locator("#chosen").innerText(), "1990-01-15");
  } finally {
    await browser.close();
  }
});

test("pickDate fills an editable text date and leaves a popup calendar alone", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input id="start" aria-label="Date Picker" value=""><input id="end" aria-label="Date Picker" value="">`);
    const driver = new BrowserDriver(page);
    await driver.pickDate({
      iso: "2020-01-15",
      formatted: "01/15/2020",
      node: { surface: "dom", role: "textbox", tag: "input", id: "start", path: [] },
    });
    await driver.pickDate({
      iso: "2024-12-31",
      formatted: "12/31/2024",
      node: { surface: "dom", role: "textbox", tag: "input", id: "end", path: [] },
    });
    assert.equal(await page.locator("#start").inputValue(), "01/15/2020");
    assert.equal(await page.locator("#end").inputValue(), "12/31/2024");
  } finally {
    await browser.close();
  }
});
