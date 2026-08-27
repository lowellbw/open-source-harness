#if DEBUG
import Foundation

/// Canned state covering every visual the transcript and panes can produce.
///
/// This exists because the interesting states are the awkward ones: a tool that
/// failed, an approval blocking a run, a compaction notice, assistant prose with real
/// Markdown in it. Reaching those in the live app means driving the UI through System
/// Events, waiting on a scripted sidecar, and — against the real gateway — paying for
/// tokens per screenshot. None of that is a good way to iterate on a layout.
///
/// Debug-only, and reached only from the Design Gallery window.
struct DesignFixture {
    var turns: [Turn] = []
    var status: AgentState = .idle
    var isStreaming = false
    var models: [ModelInfo] = []
    var selectedModel = "Standard"
    var entries: [String: [DirEntry]] = [:]
    var connectors = ConnectorStatus()
    var errorMessage: String?
    var pendingApproval: ApprovalRequest?
    var runCost = CostBuckets()
    var sessionCost = CostBuckets()
    var budgetRemaining: Double?

    /// The default gallery scenario: a finished turn with prose, reasoning, a
    /// succeeded tool, a failed tool and a running tool, then a system notice, then
    /// a user message containing an unbreakable token to prove wrapping.
    static let standard: DesignFixture = {
        var fixture = DesignFixture()
        fixture.turns = [
            Turn(id: "u1", role: .user, text: "Read data.csv and tell me what is in it."),
            Turn(
                id: "a1",
                role: .assistant,
                text: assistantMarkdown,
                reasoning: "The file is a CSV. I should read it before answering rather "
                    + "than guessing at the columns — the revenue column looked like text "
                    + "in the preview, which changes the answer.",
                tools: [
                    ToolInvocation(
                        id: "tc-1",
                        name: "read_file",
                        args: .object(["path": .string("/data.csv"), "maxBytes": .number(4096)]),
                        result: .object([
                            "bytes": .number(4096),
                            "preview": .string(csvPreview),
                        ]),
                        state: .succeeded
                    ),
                    ToolInvocation(
                        id: "tc-2",
                        name: "exec",
                        args: .object(["command": .string("python3 src/analyse.py")]),
                        result: .object([
                            "exitCode": .number(1),
                            "stderr": .string(traceback),
                        ]),
                        state: .failed
                    ),
                    ToolInvocation(
                        id: "tc-3",
                        name: "mcp__filesystem__write_file_with_a_very_long_qualified_name",
                        args: .object(["path": .string("/src/analyse.py")]),
                        state: .running
                    ),
                ],
                steps: [
                    StepRow(number: 0, toolCalls: 1, offered: 12, durationMs: 840, usd: 0.00042, finished: true),
                    StepRow(number: 1, toolCalls: 2, offered: 12, durationMs: 2_310, usd: 0.00118, finished: true),
                    StepRow(number: 2, toolCalls: 0, offered: 12, durationMs: 612, usd: 0.00031, finished: true),
                    StepRow(number: 3, toolCalls: 1, offered: 12, usd: 0, finished: false),
                ],
                subagents: [
                    SubagentRow(id: "s1", task: "Find every place the revenue column is parsed, and report which ones assume it is numeric.",
                                usd: 0.00214, reportChars: 1_842, stoppedBy: "complete"),
                    SubagentRow(id: "s2", task: "Check whether the CSV export format changed between releases.",
                                usd: 0.00090, reportChars: 0, stoppedBy: "budget_exceeded"),
                ],
                sources: [
                    Citation(url: "https://www.bea.gov/data/gdp", title: "Gross Domestic Product | U.S. Bureau of Economic Analysis"),
                    Citation(url: "https://docs.python.org/3/library/csv.html", title: ""),
                    Citation(url: "https://pandas.pydata.org/docs/reference/api/pandas.read_csv.html",
                             title: "pandas.read_csv — pandas documentation"),
                ]
            ),
            Turn(
                id: "n1",
                role: .notice,
                text: "Context compacted (tool-result-elision) — 48 messages / 186,402 tokens → 22 / 41,388",
                symbol: "arrow.down.right.and.arrow.up.left"
            ),
            Turn(
                id: "u2",
                role: .user,
                text: "Thanks. Also check this wraps: "
                    + "supercalifragilisticexpialidocious-and-then-a-great-deal-more-characters-besides"
            ),
        ]
        fixture.status = .callingTool
        fixture.isStreaming = true
        fixture.models = [
            ModelInfo(alias: "Light", tier: "light", contextWindow: 1_050_000,
                      inputPerMtok: 0.2, outputPerMtok: 1.2, isFloor: true,
                      supportsReasoningEffort: false,
                      upstreamModel: "anthropic/claude-haiku-4.5", provider: "openrouter"),
            ModelInfo(alias: "Standard", tier: "standard", contextWindow: 1_000_000,
                      inputPerMtok: 2, outputPerMtok: 10, isFloor: false,
                      supportsReasoningEffort: true,
                      upstreamModel: "anthropic/claude-sonnet-5", provider: "openrouter"),
            ModelInfo(alias: "Premium", tier: "premium", contextWindow: 1_000_000,
                      inputPerMtok: 5, outputPerMtok: 25, isFloor: false,
                      supportsReasoningEffort: true,
                      upstreamModel: "anthropic/claude-opus-5", provider: "openrouter"),
        ]
        fixture.entries = [
            "/": [
                DirEntry(name: "src", path: "/src", type: .directory, size: 0),
                DirEntry(name: "data.csv", path: "/data.csv", type: .file, size: 91_204),
                DirEntry(name: "notes.md", path: "/notes.md", type: .file, size: 2_481),
                DirEntry(name: "quarterly-report-final-v3.pdf",
                         path: "/quarterly-report-final-v3.pdf", type: .file, size: 442_119),
            ],
            "/src": [
                DirEntry(name: "analyse.py", path: "/src/analyse.py", type: .file, size: 3_120),
            ],
        ]
        fixture.connectors = ConnectorStatus(
            servers: [
                .init(id: "filesystem", era: "2025-06-18", protocolVersion: "2025-06-18"),
                .init(id: "linear", era: "2025-06-18", protocolVersion: "2025-06-18"),
                .init(id: "notion", era: "legacy", protocolVersion: nil),
            ],
            errors: [
                .init(serverId: "notion",
                      message: "handshake timed out after 10s connecting to https://mcp.notion.example/v1/sse"),
            ],
            approved: [.init(name: "filesystem.read_file", serverId: "filesystem")],
            pending: [
                .init(name: "create_issue", qualifiedName: "linear.create_issue",
                      serverId: "linear",
                      description: "Create a new issue in a Linear team, with a title, "
                          + "description, assignee and priority.",
                      status: "new"),
                .init(name: "write_file", qualifiedName: "filesystem.write_file",
                      serverId: "filesystem",
                      description: "Write bytes to a path, creating parent directories as "
                          + "needed and overwriting silently if the file already exists.",
                      status: "changed"),
            ]
        )
        fixture.runCost = CostBuckets()
        fixture.budgetRemaining = 15
        return fixture
    }()

    /// The same scenario plus the two states that overlay it.
    static var withOverlays: DesignFixture {
        var fixture = standard
        fixture.errorMessage = "The workspace server did not respond in time."
        fixture.pendingApproval = ApprovalRequest(
            approvalId: "fixture-approval",
            toolCallId: "tc-3",
            reason: "Overwrite src/analyse.py with a version that uses only the standard library.",
            irreversible: true,
            payload: .object([
                "path": .string("/src/analyse.py"),
                "bytes": .number(1806),
                "overwrites": .bool(true),
            ])
        )
        return fixture
    }

    // Kept as separate constants so the literals above stay readable.

    private static let csvPreview =
        "region,quarter,revenue,headcount\n"
        + "EMEA,Q1,\"184,320\",42\n"
        + "AMER,Q1,\"271,004\",58\n"
        + "APAC,Q1,\"96,510\",19\n"
        + "… 1,200 more rows"

    private static let traceback =
        "Traceback (most recent call last):\n"
        + "  File \"src/analyse.py\", line 3, in <module>\n"
        + "    import pandas as pd\n"
        + "ModuleNotFoundError: No module named 'pandas'"

    /// Deliberately exercises every block type the renderer has to handle: headings,
    /// bullet and ordered lists, a blockquote, inline code, a fenced block with a
    /// line long enough to need horizontal scrolling, a table, and a rule.
    private static let assistantMarkdown =
        "## What the file contains\n\n"
        + "`data.csv` has **1,204 rows** across four columns. The interesting part is that "
        + "`revenue` is stored as *text*, not a number.\n\n"
        + "### Columns\n\n"
        + "- `region` — four values: EMEA, AMER, APAC, LATAM\n"
        + "- `quarter` — Q1 through Q4\n"
        + "- `revenue` — text, with thousands separators\n"
        + "- `headcount` — integer\n\n"
        + "To use it you have to strip the separators first:\n\n"
        + "```python\n"
        + "df[\"revenue\"] = df[\"revenue\"].str.replace(\",\", \"\", regex=False).astype(float)  "
        + "# long enough that this line must scroll rather than wrap\n"
        + "```\n\n"
        + "> The separators are locale-dependent, so this is not safe on a file exported "
        + "from a non-English system.\n\n"
        + "1. Load the file\n"
        + "2. Clean the `revenue` column\n"
        + "3. Group by `region`\n\n"
        + "| Region | Q1 | Q4 |\n"
        + "|---|---|---|\n"
        + "| EMEA | 184,320 | 209,880 |\n"
        + "| AMER | 271,004 | 298,110 |\n\n"
        + "---\n\n"
        + "See [the workspace docs](https://example.com/docs) for the full schema."
}
#endif
