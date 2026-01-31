import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import FormData from "form-data";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";
import {
  filterWorkspace,
  filterSpace,
  filterGroup,
  filterPage,
  filterSearchResult,
} from "./filters.js";
import { convertProseMirrorToMarkdown } from "./markdown-converter.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

const API_URL = process.env.DOCMOST_API_URL;
const EMAIL = process.env.DOCMOST_EMAIL;
const PASSWORD = process.env.DOCMOST_PASSWORD;

if (!API_URL || !EMAIL || !PASSWORD) {
  console.error(
    "Error: DOCMOST_API_URL, DOCMOST_EMAIL, and DOCMOST_PASSWORD environment variables are required.",
  );
  process.exit(1);
}

class DocmostClient {
  // ... [Client Implementation stays exactly the same] ...
  private client: AxiosInstance;
  private token: string | null = null;

  constructor(baseURL: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async login() {
    try {
      const response = await this.client.post("/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });

      // Extract token from Set-Cookie header
      const cookies = response.headers["set-cookie"];
      if (!cookies) {
        throw new Error("No Set-Cookie header found in login response");
      }
      const authCookie = cookies.find((c: string) =>
        c.startsWith("authToken="),
      );
      if (!authCookie) {
        throw new Error("No authToken cookie found in login response");
      }

      const token = authCookie.split(";")[0].split("=")[1];

      this.token = token;
      this.client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      // console.error("Successfully logged in to Docmost API");
    } catch (error: any) {
      console.error("Login failed:", error.response?.data || error.message);
      throw error;
    }
  }

  async ensureAuthenticated() {
    if (!this.token) {
      await this.login();
    }
  }

  /**
   * Generic pagination handler for Docmost API endpoints
   * @param endpoint - The API endpoint path (e.g., "/spaces", "/pages/recent")
   * @param basePayload - Base payload object to send with each request
   * @param limit - Items per page (min: 1, max: 100, default: 100)
   * @returns All items collected from all pages
   */
  async paginateAll<T = any>(
    endpoint: string,
    basePayload: Record<string, any> = {},
    limit: number = 100,
  ): Promise<T[]> {
    await this.ensureAuthenticated();

    // Clamp limit between 1 and 100
    const clampedLimit = Math.max(1, Math.min(100, limit));

    let page = 1;
    let allItems: T[] = [];
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await this.client.post(endpoint, {
        ...basePayload,
        limit: clampedLimit,
        page,
      });

      const data = response.data;

      // Handle both direct data.items and data.data.items structures
      const items = data.data?.items || data.items || [];
      const meta = data.data?.meta || data.meta;

      allItems = allItems.concat(items);
      hasNextPage = meta?.hasNextPage || false;
      page++;
    }

    return allItems;
  }

  async getWorkspace() {
    await this.ensureAuthenticated();
    const response = await this.client.post("/workspace/info", {});
    return {
      data: filterWorkspace(response.data.data),
      success: response.data.success,
    };
  }

  async getSpaces() {
    const spaces = await this.paginateAll("/spaces", {});
    return spaces.map((space) => filterSpace(space));
  }

  async getGroups() {
    const groups = await this.paginateAll("/groups", {});
    return groups.map((group) => filterGroup(group));
  }

  async listPages(spaceId?: string) {
    const payload = spaceId ? { spaceId } : {};
    const pages = await this.paginateAll("/pages/recent", payload);
    return pages.map((page) => filterPage(page));
  }

  async getPage(pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/info", { pageId });
    return {
      data: filterPage(
        response.data.data,
        response.data.data.content
          ? convertProseMirrorToMarkdown(response.data.data.content)
          : undefined,
      ),
      success: response.data.success,
    };
  }

  /**
   * Create a new page with title and content.
   *
   * Note: As long as Docmost doesn't provide a /pages/create endpoint that allows
   * setting content directly, we must use the /pages/import workaround to create
   * pages with initial content. This method:
   * 1. Creates the page via /pages/import (which supports content)
   * 2. Moves it to the correct parent if specified
   */
  async createPage(
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ) {
    await this.ensureAuthenticated();

    if (parentPageId) {
      try {
        await this.getPage(parentPageId);
      } catch (e) {
        throw new Error(`Parent page with ID ${parentPageId} not found.`);
      }
    }

    // 1. Create content via Import
    const importRes = await this.importPage(title, content, spaceId);
    const newPageId = importRes.data.id;

    // 2. Move to parent if needed
    if (parentPageId) {
      await this.movePage(newPageId, parentPageId);
    }

    // Return the final page object
    return this.getPage(newPageId);
  }

  /**
   * Update a page's content and optionally its title.
   *
   * Note: As long as Docmost doesn't provide a /pages/update endpoint, we must use
   * a "swap-and-replace" workaround to update page content. This method:
   * 1. Fetches the old page details (space, parent, title)
   * 2. Identifies all child pages
   * 3. Creates a NEW page with the updated content via /pages/import
   * 4. Moves the new page to the old page's position (same parent)
   * 5. Re-parents all children to the new page
   * 6. Deletes the old page
   *
   * ⚠️ IMPORTANT LIMITATION: The page will get a NEW ID! Any external references
   * to the old page ID will break. The new ID is returned in the response.
   */
  async updatePage(pageId: string, content: string, title?: string) {
    await this.ensureAuthenticated();

    // 1. Get old page details to know space and parent
    const oldPageRes = await this.getPage(pageId);
    const oldPage = oldPageRes.data;
    const spaceId = oldPage.spaceId;
    const parentPageId = oldPage.parentPageId;
    const effectiveTitle = title || oldPage.title || "Untitled";

    // 2. Identify Children
    const allPages = await this.listPages(spaceId);
    const children = allPages.filter((p: any) => p.parentPageId === pageId);

    // 3. Create NEW page
    const importRes = await this.importPage(effectiveTitle, content, spaceId);
    const newPageId = importRes.data.id;

    // 4. Move NEW page to OLD page's position (same parent)
    if (parentPageId) {
      await this.movePage(newPageId, parentPageId);
    }

    // 5. Reparent Children (Rescue them!)
    for (const child of children) {
      await this.movePage(child.id, newPageId);
    }

    // 6. Delete OLD page
    await this.deletePage(pageId);

    return {
      success: true,
      newMessage:
        "Page updated safely (via swap-and-replace). Children preserved.",
      newPageId: newPageId,
      preservedChildrenCount: children.length,
    };
  }

  async importPage(title: string, content: string, spaceId: string) {
    await this.ensureAuthenticated();

    const form = new FormData();
    form.append("spaceId", spaceId);

    // We create a virtual file
    const fileContent = Buffer.from(content, "utf-8");
    form.append("file", fileContent, {
      filename: `${title || "import"}.md`,
      contentType: "text/markdown",
    });

    const headers = {
      ...form.getHeaders(),
      Authorization: `Bearer ${this.token}`,
    };

    return axios
      .post(`${API_URL}/pages/import`, form, { headers })
      .then((res) => res.data);
  }

  async search(query: string, spaceId?: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/search", {
      query,
      spaceId,
    });

    // Filter search results (data is directly an array)
    const items = response.data?.data || [];
    const filteredItems = items.map((item: any) => filterSearchResult(item));

    return {
      items: filteredItems,
      success: response.data?.success || false,
    };
  }

  async movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ) {
    await this.ensureAuthenticated();
    // Docmost requires position >= 5 chars.
    const validPosition = position || "a00000";

    return this.client
      .post("/pages/move", {
        pageId,
        parentPageId,
        position: validPosition,
      })
      .then((res) => res.data);
  }

  async deletePage(pageId: string) {
    await this.ensureAuthenticated();
    return this.client
      .post("/pages/delete", { pageId })
      .then((res) => res.data);
  }

  async deletePages(pageIds: string[]) {
    await this.ensureAuthenticated();
    const promises = pageIds.map((id) =>
      this.client
        .post("/pages/delete", { pageId: id })
        .then(() => ({ id, success: true }))
        .catch((err: any) => ({ id, success: false, error: err.message })),
    );
    return Promise.all(promises);
  }
}

const docmostClient = new DocmostClient(API_URL);

// --- Modern McpServer Implementation ---

const server = new McpServer({
  name: "docmost-mcp",
  version: VERSION,
});

// Helper to format JSON responses
const jsonContent = (data: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// Tool: list_workspaces
server.registerTool(
  "get_workspace",
  {
    description: "Get the current Docmost workspace",
  },
  async () => {
    const workspace = await docmostClient.getWorkspace();
    return jsonContent(workspace);
  },
);

// Tool: list_spaces
server.registerTool(
  "list_spaces",
  {
    description: "List all available spaces in Docmost",
  },
  async () => {
    const spaces = await docmostClient.getSpaces();
    return jsonContent(spaces);
  },
);

// Tool: list_groups
server.registerTool(
  "list_groups",
  {
    description: "List all available groups in Docmost",
  },
  async () => {
    const groups = await docmostClient.getGroups();
    return jsonContent(groups);
  },
);

// Tool: list_pages
server.registerTool(
  "list_pages",
  {
    description: "List pages in a space ordered by updatedAt (descending).",
    inputSchema: {
      spaceId: z.string().optional(),
    },
  },
  async ({ spaceId }) => {
    const result = await docmostClient.listPages(spaceId);
    return jsonContent(result);
  },
);

// Tool: get_page
server.registerTool(
  "get_page",
  {
    description: "Get details and content of a specific page by ID",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    const page = await docmostClient.getPage(pageId);
    return jsonContent(page);
  },
);

// Tool: create_page (Smart)
server.registerTool(
  "create_page",
  {
    description:
      "Create a new page with content (automatically moves it to the correct hierarchy).",
    inputSchema: {
      title: z.string().describe("Title of the page"),
      content: z.string().describe("Markdown content"),
      spaceId: z.string(),
      parentPageId: z
        .string()
        .optional()
        .describe("Optional parent page ID to nest under"),
    },
  },
  async ({ title, content, spaceId, parentPageId }) => {
    const result = await docmostClient.createPage(
      title,
      content,
      spaceId,
      parentPageId,
    );
    return jsonContent(result);
  },
);

// Tool: update_page (Safe)
server.registerTool(
  "update_page",
  {
    description:
      "Update a page's content safely (preserves child pages by moving them). Note: Returns a NEW pageId.",
    inputSchema: {
      pageId: z.string().describe("ID of the page to update"),
      content: z.string().describe("New Markdown content"),
      title: z
        .string()
        .optional()
        .describe("Optional new title (defaults to old title)"),
    },
  },
  async ({ pageId, content, title }) => {
    const result = await docmostClient.updatePage(pageId, content, title);
    return jsonContent(result);
  },
);

// Tool: move_page
server.registerTool(
  "move_page",
  {
    description:
      "Move a page to a new parent (nesting) or root. Essential for organizing pages created via 'import_page'.",
    inputSchema: {
      pageId: z.string(),
      parentPageId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Target parent page ID. Pass 'null' or empty string to move to root.",
        ),
      position: z
        .string()
        .optional()
        .describe(
          "Optional position string (5-12 chars). Defaults to 'a00000' (end) if omitted.",
        ),
    },
  },
  async ({ pageId, parentPageId, position }) => {
    // Ensure parentPageId is null if string "null" or empty is passed, or undefined
    // Note: Zod handles type checking, but we double check for empty strings just in case
    const finalParentId =
      parentPageId === "" || parentPageId === "null" ? null : parentPageId;

    await docmostClient.movePage(pageId, finalParentId || null, position);
    return {
      content: [
        {
          type: "text",
          text: `Successfully moved page ${pageId} to parent ${finalParentId || "root"}`,
        },
      ],
    };
  },
);

// Tool: delete_page
server.registerTool(
  "delete_page",
  {
    description: "Delete a single page by ID.",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    await docmostClient.deletePage(pageId);
    return {
      content: [{ type: "text", text: `Successfully deleted page ${pageId}` }],
    };
  },
);

// Tool: delete_pages
server.registerTool(
  "delete_pages",
  {
    description: "Delete multiple pages at once. Useful for cleanup.",
    inputSchema: {
      pageIds: z.array(z.string()),
    },
  },
  async ({ pageIds }) => {
    const results = await docmostClient.deletePages(pageIds);
    return jsonContent(results);
  },
);

// Tool: search
server.registerTool(
  "search",
  {
    description: "Search for pages and content.",
    inputSchema: {
      query: z.string().describe("Search query"),
      spaceId: z.string().optional().describe("Optional space ID to filter by"),
    },
  },
  async ({ query, spaceId }) => {
    const result = await docmostClient.search(query, spaceId);
    return jsonContent(result);
  },
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
