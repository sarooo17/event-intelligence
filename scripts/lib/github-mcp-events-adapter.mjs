const ISSUE_ACTIONS = ['opened', 'reopened', 'edited', 'closed'];

function descriptor(action) {
  return {
    name: `github.issue.${action}`,
    description: `A GitHub issue was ${action}.`,
    delivery: ['poll'],
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string' },
        label: { type: 'string' },
        sender: { type: 'string' },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: 'object',
      required: ['repository', 'number', 'title', 'labels', 'action'],
      properties: {
        repository: { type: 'string' },
        number: { type: 'integer' },
        title: { type: 'string' },
        bodyPreview: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
        sender: { type: ['string', 'null'] },
        action: { type: 'string' },
        url: { type: ['string', 'null'] },
      },
    },
  };
}

export function githubMcpEventDescriptors() {
  return ISSUE_ACTIONS.map(descriptor);
}

export function githubMcpEventMatcher(args, event) {
  if (args.repository && event.data.repository !== args.repository) return false;
  if (args.sender && event.data.sender !== args.sender) return false;
  if (
    args.label &&
    (!Array.isArray(event.data.labels) ||
      !event.data.labels.includes(args.label))
  ) {
    return false;
  }
  return true;
}

export function registerGitHubMcpEvents(server) {
  for (const eventDescriptor of githubMcpEventDescriptors()) {
    server.registerEvent({
      descriptor: eventDescriptor,
      matcher: githubMcpEventMatcher,
    });
  }
}

export async function ingestGitHubMcpEvent(store, event) {
  if (!ISSUE_ACTIONS.some((action) => event.name === `github.issue.${action}`)) {
    throw new Error(`Unsupported GitHub MCP event: ${event.name}`);
  }

  return store.appendMcpOccurrence('github-mcp-events', event);
}
