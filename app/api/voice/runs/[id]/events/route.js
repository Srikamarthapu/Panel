import { getAssistantRun, publicAssistantRun } from "@/lib/assistant-runs";
import { readAssistantText } from "@/lib/assistant-stream";

export const dynamic = "force-dynamic";
export async function GET(request, { params }) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const sessionId = query.get("sessionId");
  if (!sessionId || !getAssistantRun(id, sessionId)) return Response.json({ error: "Request not found." }, { status: 404 });
  let after = Math.max(0, Number(query.get("after") || request.headers.get("last-event-id")) || 0);
  let timer, closed = false, signature = "", heartbeat = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      function stop() { if (closed) return; closed = true; clearInterval(timer); try { controller.close(); } catch {} }
      function poll() {
        if (closed) return;
        try {
          for (const event of readAssistantText(id, after)) {
            controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: text\ndata: ${JSON.stringify(event)}\n\n`));
            after = event.seq;
          }
          const run = publicAssistantRun(getAssistantRun(id, sessionId));
          const next = JSON.stringify(run);
          if (next !== signature) { controller.enqueue(encoder.encode(`event: run\ndata: ${next}\n\n`)); signature = next; }
          if (!run || ["complete", "error", "cancelled", "interrupted"].includes(run.state)) { stop(); return; }
          if (Date.now() - heartbeat > 10_000) { controller.enqueue(encoder.encode(": heartbeat\n\n")); heartbeat = Date.now(); }
        } catch { stop(); }
      }
      request.signal.addEventListener("abort", stop, { once: true });
      timer = setInterval(poll, 100);
      poll();
    },
    cancel() { closed = true; clearInterval(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
}
