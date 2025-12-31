import express from 'express';
import jsforce from 'jsforce';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const app = express();
app.use(express.json());

// Store active transports
const transports = {};

// Salesforce connection
let sfConnection = null;

async function connectToSalesforce() {
  const conn = new jsforce.Connection({
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
    version: '59.0'
  });

  if (process.env.SALESFORCE_ACCESS_TOKEN) {
    conn.accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  } else {
    // OAuth 2.0 Client Credentials flow
    await conn.login(
      process.env.SALESFORCE_USERNAME,
      process.env.SALESFORCE_PASSWORD + process.env.SALESFORCE_SECURITY_TOKEN
    );
  }

  return conn;
}

// Create MCP Server
function createMcpServer() {
  const server = new Server(
    { name: 'salesforce-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'soql_query',
        description: 'Execute a SOQL query against Salesforce',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'SOQL query string' }
          },
          required: ['query']
        }
      },
      {
        name: 'get_object_metadata',
        description: 'Get metadata for a Salesforce object',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string', description: 'API name of the object (e.g., Account, Contact)' }
          },
          required: ['objectName']
        }
      },
      {
        name: 'create_record',
        description: 'Create a new record in Salesforce',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string', description: 'API name of the object' },
            data: { type: 'object', description: 'Field values for the new record' }
          },
          required: ['objectName', 'data']
        }
      },
      {
        name: 'update_record',
        description: 'Update an existing Salesforce record',
        inputSchema: {
          type: 'object',
          properties: {
            objectName: { type: 'string', description: 'API name of the object' },
            recordId: { type: 'string', description: 'Salesforce record ID' },
            data: { type: 'object', description: 'Field values to update' }
          },
          required: ['objectName', 'recordId', 'data']
        }
      },
      {
        name: 'search_records',
        description: 'Search Salesforce using SOSL',
        inputSchema: {
          type: 'object',
          properties: {
            searchTerm: { type: 'string', description: 'Search term' },
            objects: { type: 'array', items: { type: 'string' }, description: 'Objects to search (e.g., ["Account", "Contact"])' }
          },
          required: ['searchTerm']
        }
      }
    ]
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (!sfConnection) {
        sfConnection = await connectToSalesforce();
      }

      switch (name) {
        case 'soql_query': {
          const result = await sfConnection.query(args.query);
          return { content: [{ type: 'text', text: JSON.stringify(result.records, null, 2) }] };
        }

        case 'get_object_metadata': {
          const metadata = await sfConnection.describe(args.objectName);
          const simplified = {
            name: metadata.name,
            label: metadata.label,
            fields: metadata.fields.map(f => ({
              name: f.name,
              label: f.label,
              type: f.type,
              required: !f.nillable
            }))
          };
          return { content: [{ type: 'text', text: JSON.stringify(simplified, null, 2) }] };
        }

        case 'create_record': {
          const result = await sfConnection.sobject(args.objectName).create(args.data);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'update_record': {
          const updateData = { Id: args.recordId, ...args.data };
          const result = await sfConnection.sobject(args.objectName).update(updateData);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'search_records': {
          const objects = args.objects || ['Account', 'Contact', 'Opportunity'];
          const sosl = `FIND {${args.searchTerm}} IN ALL FIELDS RETURNING ${objects.join(', ')}`;
          const result = await sfConnection.search(sosl);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });

  return server;
}

// SSE endpoint
app.get('/sse', async (req, res) => {
  console.log('New SSE connection');

  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    console.log('SSE connection closed:', transport.sessionId);
    delete transports[transport.sessionId];
  });

  const server = createMcpServer();
  await server.connect(transport);
});

// Messages endpoint
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: 'No transport found for sessionId' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'salesforce-mcp-sse' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Salesforce MCP Server running on port ${PORT}`);
  console.log(`SSE endpoint: /sse`);
});
