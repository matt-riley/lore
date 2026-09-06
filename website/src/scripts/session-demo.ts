import { createSession, transitionSession } from "./demo-model.mjs";

document.querySelectorAll<HTMLElement>("[data-session-demo]").forEach((demo, index) => {
  type State = { phase: string; draft: string; memory: { content: string; scope: string; repository: string; type: string } | null; session: number };
  let state: State = createSession();
  const input = demo.querySelector<HTMLTextAreaElement>("[data-memory-input]")!;
  input.id = `sample-memory-${index}`;
  demo.querySelector<HTMLLabelElement>("label")!.htmlFor = input.id;
  const save = demo.querySelector<HTMLButtonElement>("[data-save]")!;
  const next = demo.querySelector<HTMLButtonElement>("[data-next]")!;
  const recall = demo.querySelector<HTMLButtonElement>("[data-recall]")!;
  const update = () => {
    const { phase, memory } = state;
    input.value = state.draft;
    input.disabled = phase !== "draft";
    const freshConversation = phase === "new-session" || phase === "recalled";
    demo.querySelector<HTMLElement>("[data-draft-conversation]")!.hidden = freshConversation;
    demo.querySelector<HTMLElement>("[data-new-conversation]")!.hidden = !freshConversation;
    save.disabled = phase !== "draft" || !state.draft.trim();
    next.disabled = phase !== "saved";
    recall.disabled = phase !== "new-session";
    demo.dataset.phase = phase;
    demo.querySelector<HTMLElement>("[data-session-name]")!.textContent = `Session 0${state.session}`;
    demo.querySelector<HTMLElement>("[data-memory-count]")!.textContent = memory ? "1 note" : "0 notes";
    demo.querySelector<HTMLElement>("[data-memory-content]")!.textContent = memory?.content || "Your saved preference will appear here.";
    demo.querySelector<HTMLElement>("[data-memory-meta]")!.textContent = memory ? "demo/orchard · user_preference · saved in session 01" : "Local to this example";
    const messages: Record<string, [string, string]> = {
      draft: ["Ready to remember", "Nothing saved yet. Give this session something worth keeping."],
      saved: ["Preference saved", "Your preference is in Lore’s memory. Now start a new session to see what carries over."],
      "new-session": ["A fresh conversation", "The conversation is new; the saved preference remains. Ask Pi to recall it."],
      recalled: ["Context recovered", `Lore recalled your saved preference: “${memory?.content}”`],
    };
    demo.querySelector<HTMLElement>("[data-session-state]")!.textContent = messages[phase][0];
    demo.querySelector<HTMLElement>("[data-session-feedback]")!.textContent = messages[phase][1];
    const call = demo.querySelector<HTMLElement>("[data-tool-call]")!;
    call.textContent = phase === "draft" ? "No tool call yet." : phase === "recalled" && memory
      ? `lore_recall(${JSON.stringify({ query: "What preferences have I saved for this project?", repository: "demo/orchard", limit: 6 }, null, 2)})\n\nExample recalled memory:\n${memory.content}`
      : `lore_save(${JSON.stringify(memory, null, 2)})${phase === "new-session" ? "\n\nA new Pi session starts. The saved memory remains." : "\n\nExample result: preference saved."}`;
    const current = phase === "draft" ? 0 : phase === "saved" ? 1 : 2;
    demo.querySelectorAll(".demo-progress li").forEach((item, i) => {
      if (i === current) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  };
  input.addEventListener("input", () => {
    state = transitionSession(state, "edit", input.value);
    save.disabled = !state.draft.trim();
  });
  const run = (action: string) => { state = transitionSession(state, action); update(); };
  save.addEventListener("click", () => { run("save"); next.focus(); });
  next.addEventListener("click", () => { run("next"); recall.focus(); });
  recall.addEventListener("click", () => { run("recall"); demo.querySelector<HTMLButtonElement>("[data-reset]")!.focus(); });
  demo.querySelector<HTMLButtonElement>("[data-reset]")!.addEventListener("click", () => { run("reset"); input.focus(); });
});
