import { scopeMemories, retrievalExample } from "./demo-model.mjs";

const scopeDemo = document.querySelector<HTMLElement>("[data-scope-demo]")!;
const repository = document.querySelector<HTMLSelectElement>("#demo-repository")!;
function renderScope() {
  const rows = scopeMemories(repository.value);
  const list = scopeDemo.querySelector<HTMLUListElement>("[data-scope-list]")!;
  list.replaceChildren();
  rows.forEach((memory) => {
    const item = document.createElement("li");
    item.dataset.eligible = String(memory.eligible);
    const text = document.createElement("p");
    text.textContent = memory.content;
    const scope = document.createElement("span");
    scope.className = "scope-meta";
    scope.textContent = memory.scope === "global" ? "Global preference" : memory.repository;
    const reason = document.createElement("span");
    reason.className = "scope-reason";
    reason.textContent = `${memory.eligible ? "Included" : "Not selected"} · ${memory.reason}`;
    item.append(text, scope, reason);
    list.append(item);
  });
  const count = rows.filter((row) => row.eligible).length;
  scopeDemo.querySelector<HTMLElement>("[data-scope-count]")!.textContent = `${count} of ${rows.length} memories included`;
  scopeDemo.querySelector<HTMLElement>("[data-scope-summary]")!.textContent = `You’re in ${repository.value}. Its project notes and the global preference are included in this example; notes specific to the other repository are not selected.`;
  scopeDemo.querySelector<HTMLElement>("[data-scope-call]")!.textContent = `lore_recall(${JSON.stringify({ query: "project preferences", repository: repository.value, limit: 6 }, null, 2)})`;
}
repository.addEventListener("change", renderScope);
renderScope();

const retrievalDemo = document.querySelector<HTMLElement>("[data-retrieval-demo]")!;
function renderRetrieval(mode: string) {
  const result = retrievalExample(mode);
  const renderList = (selector: string, rows: string[], empty: string) => {
    const list = retrievalDemo.querySelector<HTMLUListElement>(selector)!;
    list.replaceChildren();
    (rows.length ? rows : [empty]).forEach((text: string) => {
      const item = document.createElement("li");
      item.textContent = text;
      item.className = rows.length ? "example-match" : "example-empty";
      list.append(item);
    });
  };
  renderList("[data-lexical-results]", result.lexical, "No lexical candidate in this example.");
  renderList("[data-semantic-results]", result.semantic, mode === "offline" ? "Local endpoint unavailable. No semantic candidates added." : "Enable local embeddings to see the example meaning-based match.");
  retrievalDemo.querySelector<HTMLElement>("[data-retrieval-explanation]")!.textContent = result.explanation;
}
retrievalDemo.querySelectorAll<HTMLInputElement>("input[name=retrieval-mode]").forEach((input) => input.addEventListener("change", () => renderRetrieval(input.value)));
renderRetrieval("keyword");
