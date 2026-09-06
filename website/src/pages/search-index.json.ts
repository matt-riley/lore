import { getCollection } from "astro:content";

export async function GET() {
  const docs = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);
  return new Response(JSON.stringify([{ title: "Try Lore", description: "Interactive Pi session, repository scope, and semantic search demonstrations.", url: "/playground/", body: "save recall memory sample example local embeddings offline fallback repository" }, ...docs.map((doc) => ({
    title: doc.data.title,
    description: doc.data.description,
    url: `/guides/${doc.id}/`,
    body: doc.body || "",
  }))]), { headers: { "Content-Type": "application/json" } });
}
