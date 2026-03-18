import "dotenv/config";
import express from "express";
import { LinearClient } from "@linear/sdk";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3123;

const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

app.use(express.static(join(__dirname, "public")));

// ── API: list teams ──────────────────────────────────────────────────

app.get("/api/teams", async (_req, res) => {
  try {
    const teams = await linear.teams();
    const result = await Promise.all(
      teams.nodes.map(async (t) => {
        const members = await t.members();
        return {
          id: t.id,
          key: t.key,
          name: t.name,
          memberCount: members.nodes.length,
        };
      })
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: fetch activity for a team ───────────────────────────────────

app.get("/api/activity/:teamId", async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const team = await linear.team(req.params.teamId);
    const membersConn = await team.members();
    const members = membersConn.nodes;

    const results = await Promise.all(
      members.map(async (member) => {
        const [updatedIssues, createdIssues, comments] = await Promise.all([
          linear.issues({
            filter: {
              updatedAt: { gte: since },
              assignee: { id: { eq: member.id } },
            },
            first: 50,
          }),
          linear.issues({
            filter: {
              createdAt: { gte: since },
              creator: { id: { eq: member.id } },
            },
            first: 50,
          }),
          linear.comments({
            filter: {
              createdAt: { gte: since },
              user: { id: { eq: member.id } },
            },
            first: 50,
          }),
        ]);

        const resolveIssue = async (i) => {
          const state = await i.state;
          return {
            identifier: i.identifier,
            title: i.title,
            state: state?.name ?? "Unknown",
          };
        };

        const commentData = await Promise.all(
          comments.nodes.map(async (c) => {
            const issue = await c.issue;
            return {
              body: c.body,
              issue: issue
                ? { identifier: issue.identifier, title: issue.title }
                : null,
            };
          })
        );

        return {
          id: member.id,
          name: member.name,
          updatedIssues: await Promise.all(updatedIssues.nodes.map(resolveIssue)),
          createdIssues: await Promise.all(createdIssues.nodes.map(resolveIssue)),
          comments: commentData,
        };
      })
    );

    // Sort: members with activity first
    results.sort((a, b) => {
      const aTotal = a.updatedIssues.length + a.createdIssues.length + a.comments.length;
      const bTotal = b.updatedIssues.length + b.createdIssues.length + b.comments.length;
      return bTotal - aTotal;
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Standup tool running at http://localhost:${PORT}`);
});
