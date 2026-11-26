// Starts the subway-wait GitHub Actions workflow every 5 minutes.
// Needs one secret, GH_TOKEN (fine-grained token: this repo only, Actions: read & write).
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  async fetch() {
    return new Response("subway-trigger is running", { status: 200 });
  },
};

async function dispatch(env) {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "subway-update",
    },
    body: JSON.stringify({ ref: env.GH_REF }),
  });
  if (res.status !== 204) console.log("dispatch failed", res.status, await res.text());
}
