export const dynamic = "force-dynamic";
const retired = () => Response.json({ error: "This legacy dashboard endpoint has been retired. Use Sessions, Tasks, or Tools." }, { status: 410 });
export { retired as GET, retired as POST, retired as PATCH, retired as PUT, retired as DELETE };
