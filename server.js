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

// ── Resolve workflow state name by ID (cached) ───────────────────────

const stateCache = new Map();

async function resolveStateName(stateId) {
  if (!stateId) return null;
  if (stateCache.has(stateId)) return stateCache.get(stateId);
  try {
    const s = await linear.workflowState(stateId);
    stateCache.set(stateId, s.name);
    return s.name;
  } catch {
    return null;
  }
}

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

        // Build a map of issue identifier -> issue data
        const issueMap = new Map();

        const resolveAndAdd = async (i, section) => {
          const state = await i.state;

          // Get state transitions within the timeframe
          const history = await i.history({ first: 20 });
          const transitions = (await Promise.all(
            history.nodes
              .filter((h) => h.fromStateId && h.toStateId && new Date(h.createdAt) >= new Date(since))
              .map(async (h) => {
                const [fromName, toName] = await Promise.all([
                  resolveStateName(h.fromStateId),
                  resolveStateName(h.toStateId),
                ]);
                return fromName && toName ? `${fromName} → ${toName}` : null;
              })
          )).filter(Boolean);

          const key = i.identifier;
          if (!issueMap.has(key)) {
            issueMap.set(key, {
              identifier: i.identifier,
              title: i.title,
              url: i.url,
              state: state?.name ?? "Unknown",
              stateTransitions: transitions,
              sections: new Set(),
              comments: [],
            });
          }
          const entry = issueMap.get(key);
          entry.sections.add(section);
          // Merge transitions if not already present
          for (const t of transitions) {
            if (!entry.stateTransitions.includes(t)) {
              entry.stateTransitions.push(t);
            }
          }
        };

        await Promise.all([
          ...updatedIssues.nodes.map((i) => resolveAndAdd(i, "updated")),
          ...createdIssues.nodes.map((i) => resolveAndAdd(i, "created")),
        ]);

        // Attach comments to their parent issues (only if assigned to this member)
        const orphanComments = [];
        await Promise.all(
          comments.nodes.map(async (c) => {
            const issue = await c.issue;
            if (!issue) return;
            const assignee = await issue.assignee;
            if (assignee && assignee.id !== member.id) return;

            const body = c.body;
            const key = issue.identifier;
            if (issueMap.has(key)) {
              issueMap.get(key).comments.push(body);
            } else {
              // Comment on own issue that wasn't in updated/created (edge case)
              orphanComments.push({
                body,
                issue: { identifier: issue.identifier, title: issue.title, url: issue.url },
              });
            }
          })
        );

        // Convert map to arrays, preserving updated vs created
        const issues = [];
        for (const entry of issueMap.values()) {
          issues.push({
            identifier: entry.identifier,
            title: entry.title,
            url: entry.url,
            state: entry.state,
            stateTransitions: entry.stateTransitions,
            created: entry.sections.has("created"),
            comments: entry.comments,
          });
        }

        return {
          id: member.id,
          name: member.name,
          issues,
          orphanComments,
        };
      })
    );

    // Sort: members with activity first
    results.sort((a, b) => {
      const aTotal = a.issues.length + a.orphanComments.length;
      const bTotal = b.issues.length + b.orphanComments.length;
      return bTotal - aTotal;
    });

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Standup tool running at http://localhost:${PORT}`);
});
