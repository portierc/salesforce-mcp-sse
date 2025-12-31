import express from 'express';
import jsforce from 'jsforce';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

// CORS for n8n compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// API Key Authentication Middleware
const API_KEY = process.env.MCP_API_KEY;

function authenticateRequest(req, res, next) {
  if (!API_KEY) {
    return next();
  }
  const authHeader = req.headers.authorization;
  const queryKey = req.query.api_key;
  const providedKey = authHeader?.replace('Bearer ', '') || queryKey;
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid or missing API key' });
  }
  next();
}

// Salesforce connection
let sfConnection = null;

async function connectToSalesforce() {
  if (process.env.SALESFORCE_REFRESH_TOKEN) {
    const clientId = process.env.SALESFORCE_CLIENT_ID || 'PlatformCLI';
    const oauth2Config = {
      clientId: clientId,
      redirectUri: process.env.SALESFORCE_CALLBACK_URL || 'https://login.salesforce.com/services/oauth2/success'
    };
    if (process.env.SALESFORCE_CLIENT_SECRET) {
      oauth2Config.clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
    }
    const oauth2 = new jsforce.OAuth2(oauth2Config);
    const conn = new jsforce.Connection({
      oauth2: oauth2,
      instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
      refreshToken: process.env.SALESFORCE_REFRESH_TOKEN,
      version: '59.0'
    });
    await conn.identity();
    console.log('Connected to Salesforce via refresh token');
    return conn;
  }

  if (process.env.SALESFORCE_ACCESS_TOKEN) {
    const conn = new jsforce.Connection({
      instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
      accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
      version: '59.0'
    });
    console.log('Connected to Salesforce via access token');
    return conn;
  }

  const conn = new jsforce.Connection({
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
    version: '59.0'
  });
  await conn.login(
    process.env.SALESFORCE_USERNAME,
    process.env.SALESFORCE_PASSWORD + process.env.SALESFORCE_SECURITY_TOKEN
  );
  console.log('Connected to Salesforce via username/password');
  return conn;
}

// Create MCP Server with tools
function createMcpServer() {
  const server = new McpServer({
    name: 'salesforce-mcp',
    version: '1.0.0',
  });

  // SOQL Query tool
  server.tool(
    'soql_query',
    'Execute a SOQL query against Salesforce',
    { query: z.string().describe('SOQL query string') },
    async ({ query }) => {
      if (!sfConnection) sfConnection = await connectToSalesforce();
      const result = await sfConnection.query(query);
      return { content: [{ type: 'text', text: JSON.stringify(result.records, null, 2) }] };
    }
  );

  // Get Object Metadata tool
  server.tool(
    'get_object_metadata',
    'Get metadata for a Salesforce object',
    { objectName: z.string().describe('API name of the object (e.g., Account, Contact)') },
    async ({ objectName }) => {
      if (!sfConnection) sfConnection = await connectToSalesforce();
      const metadata = await sfConnection.describe(objectName);
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
  );

  // Create Record tool
  server.tool(
    'create_record',
    'Create a new record in Salesforce',
    {
      objectName: z.string().describe('API name of the object'),
      data: z.record(z.any()).describe('Field values for the new record')
    },
    async ({ objectName, data }) => {
      if (!sfConnection) sfConnection = await connectToSalesforce();
      const result = await sfConnection.sobject(objectName).create(data);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Update Record tool
  server.tool(
    'update_record',
    'Update an existing Salesforce record',
    {
      objectName: z.string().describe('API name of the object'),
      recordId: z.string().describe('Salesforce record ID'),
      data: z.record(z.any()).describe('Field values to update')
    },
    async ({ objectName, recordId, data }) => {
      if (!sfConnection) sfConnection = await connectToSalesforce();
      const updateData = { Id: recordId, ...data };
      const result = await sfConnection.sobject(objectName).update(updateData);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Search Records tool
  server.tool(
    'search_records',
    'Search Salesforce using SOSL',
    {
      searchTerm: z.string().describe('Search term'),
      objects: z.array(z.string()).optional().describe('Objects to search (e.g., ["Account", "Contact"])')
    },
    async ({ searchTerm, objects }) => {
      if (!sfConnection) sfConnection = await connectToSalesforce();
      const searchObjects = objects || ['Account', 'Contact', 'Opportunity'];
      const sosl = `FIND {${searchTerm}} IN ALL FIELDS RETURNING ${searchObjects.join(', ')}`;
      const result = await sfConnection.search(sosl);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// Store transports by session ID
const transports = {};

// MCP endpoint - Streamable HTTP transport
app.post('/mcp', authenticateRequest, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  let transport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing transport
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });
    transports[newSessionId] = transport;

    const server = createMcpServer();
    await server.connect(transport);

    console.log('New MCP session:', newSessionId);
  } else if (sessionId && !transports[sessionId]) {
    // Invalid session
    res.status(400).json({ error: 'Invalid session ID' });
    return;
  } else {
    // No session and not initialize request
    res.status(400).json({ error: 'Missing session ID or not an initialize request' });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// Handle GET for SSE streams (optional, for clients that need it)
app.get('/mcp', authenticateRequest, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

// Handle DELETE for session cleanup
app.delete('/mcp', authenticateRequest, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].close();
    delete transports[sessionId];
    console.log('Session closed:', sessionId);
  }
  res.status(200).json({ status: 'ok' });
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'salesforce-mcp', transport: 'streamable-http' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Salesforce MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp (Streamable HTTP)`);
});
