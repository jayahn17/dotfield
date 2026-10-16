// Rule family "mcp": mcp/server.mjs and its transports. Gate id: "mcp".
export const family = 'mcp';
export const gate = 'mcp';
export const rules = {
  DF_MCP_SDK_MISSING: { gate, blocking: false,
    message: 'The optional @modelcontextprotocol/sdk is not installed.',
    repair: 'Run npm install @modelcontextprotocol/sdk; the CLI and server work without it.' },
  DF_MCP_APPROVE_TOOL: { gate, blocking: true,
    message: 'A tool whose name contains approve is registered.',
    repair: 'Remove it; approve is a CLI verb and an inbox button, never an MCP tool.' },
  DF_MCP_TOOL_COUNT: { gate, blocking: true,
    message: 'The registered tool count differs from the pinned 12.',
    repair: 'Change PINNED.mcp_tools and references/RULES.md in the same commit as the tool, with the reason.' },
  DF_MCP_UNAUTHORIZED: { gate, blocking: true, exit: 3,
    message: 'The HTTP transport request lacks the bearer DOTFIELD_MCP_AUTH_TOKEN.',
    repair: 'Send Authorization: Bearer <token> from the environment that started mcp/http.mjs.' },
  DF_MCP_VIEWER_UNKNOWN: { gate, blocking: true,
    message: 'The viewer argument names a person that is not in center/people/.',
    repair: 'Omit viewer for the public projection or pass a known person_id.' },
  DF_MCP_TOOL_INPUT_INVALID: { gate, blocking: true,
    message: 'The tool arguments do not match the tool input schema.',
    repair: 'Fix the arguments using the DF_SCHEMA_* findings in structuredContent.' },
  DF_MCP_METHOD_NOT_ALLOWED: { gate, blocking: true,
    message: 'GET and DELETE are not supported on the stateless HTTP transport.',
    repair: 'Use POST for every MCP message.' },
};
