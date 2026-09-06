import { searchDocs } from "./search.mjs";

const menu = document.querySelector<HTMLButtonElement>(".menu-toggle");
const nav = document.querySelector<HTMLElement>(".main-nav");
menu?.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  nav?.classList.toggle("is-open", open);
});

const dialog = document.querySelector<HTMLDialogElement>(".search-dialog")!;
const input = document.querySelector<HTMLInputElement>("#docs-search")!;
const results = document.querySelector<HTMLUListElement>(".search-results")!;
const status = document.querySelector<HTMLElement>(".search-status")!;
type SearchEntry = { title: string; description: string; body: string; url: string };
let indexPromise: Promise<SearchEntry[]> | undefined;
let queryVersion = 0;
async function updateResults() {
  const version = ++queryVersion;
  status.textContent = "Finding your way…";
  try {
    indexPromise ??= fetch("/search-index.json").then((response) => {
      if (!response.ok) throw new Error("Search index unavailable");
      return response.json();
    });
    const entries = await indexPromise;
    if (version !== queryVersion) return;
    const matches: SearchEntry[] = searchDocs(entries, input.value);
    results.replaceChildren();
    for (const entry of matches) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = entry.url;
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const description = document.createElement("span");
      description.textContent = entry.description;
      link.append(title, description);
      li.append(link);
      results.append(li);
    }
    status.textContent = !input.value.trim() ? "A good place to begin." : matches.length ? `${matches.length} ${matches.length === 1 ? "guide" : "guides"} found.` : "No guides found. Try a broader term, like ‘memory’ or ‘install’.";
  } catch {
    indexPromise = undefined;
    if (version !== queryVersion) return;
    results.replaceChildren();
    status.textContent = "Search couldn’t load. Please try again, or browse the Guides page.";
  }
}
function openSearch() {
  if (!dialog.open) dialog.showModal();
  input.focus();
  void updateResults();
}
document.querySelectorAll("[data-search-open]").forEach((button) => button.addEventListener("click", openSearch));
document.querySelector("[data-search-close]")?.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});
input.addEventListener("input", () => void updateResults());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
});
document.querySelectorAll<HTMLPreElement>(".prose pre").forEach((pre) => {
  const code = pre.querySelector("code")?.textContent || "";
  const button = document.createElement("button");
  button.className = "copy-code";
  button.type = "button";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code to clipboard");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select to copy";
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pre.querySelector("code")!);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    window.setTimeout(() => { button.textContent = "Copy"; }, 2000);
  });
  pre.append(button);
});

const headingLinks = document.querySelectorAll<HTMLAnchorElement>(".toc a");
if (headingLinks.length) {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);
    if (!visible) return;
    headingLinks.forEach((link) => {
      if (link.hash === `#${visible.target.id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-100px 0px -65% 0px" });
  document.querySelectorAll(".prose h2").forEach((heading) => observer.observe(heading));
}
