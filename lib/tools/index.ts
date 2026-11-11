import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestApiKey, resolveApiKey } from "@/lib/opendart/client";
import { searchCompanies } from "@/lib/opendart/cache";
import { registerDartDocTools } from "@/lib/dartDoc";
import { registerCompanyTools } from "./company";
import { registerFinancialTools } from "./financial";
import { registerDisclosureTools } from "./disclosure";
import { registerShareholdingTools } from "./shareholding";
import { registerMajorEventTools } from "./major-events";
import { registerSecuritiesRegTools } from "./securities-reg";
import { registerWorkflowTools } from "./workflows";
import { registerFootingTools } from "./footing";

function registerConfigTools(server: McpServer) {
  // Each MCP request runs on a fresh server with no session state, so a key
  // given here cannot carry over to later tool calls. Storing it anywhere
  // shared would leak it to other users on the same instance.
  server.tool(
    "set_api_key",
    "Explains how to provide your OpenDART API key. The server keeps no session state, so keys cannot be stored by this tool — append ?opendart_key=YOUR_KEY to the MCP server URL, or pass api_key to each tool. / OpenDART API 키 전달 방법을 안내합니다. 서버는 세션 상태를 저장하지 않아 이 도구로 키를 저장할 수 없습니다. MCP 서버 URL 끝에 ?opendart_key=발급키 를 붙이거나 각 도구의 api_key 인자로 넘기세요.",
    { api_key: z.string().describe("Your OpenDART API key (not stored) / OpenDART API 인증키(저장되지 않음)") },
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "The key was NOT stored: this server keeps no state between requests. " +
              "Append ?opendart_key=YOUR_KEY to the MCP server URL (connector settings), or pass api_key to each tool call. / " +
              "키를 저장하지 않았습니다. 이 서버는 요청 사이에 상태를 남기지 않습니다. " +
              "커넥터 설정의 MCP 서버 URL 끝에 ?opendart_key=발급키 를 붙이거나, 도구를 호출할 때마다 api_key 인자로 넘기세요.",
          },
        ],
      };
    }
  );

  server.tool(
    "get_api_key_status",
    "Check whether an OpenDART API key is configured. / OpenDART API 키 설정 여부를 확인합니다.",
    {},
    async () => {
      const hasRequestKey = !!getRequestApiKey();
      const hasEnv = !!process.env.OPENDART_API_KEY;

      let status: string;
      if (hasRequestKey) {
        status = "API key is provided via the server URL (?opendart_key=). / 서버 URL(?opendart_key=)로 API 키가 전달되었습니다.";
      } else if (hasEnv) {
        status = "Server API key is configured (environment variable). / 서버 API 키가 설정되어 있습니다.";
      } else {
        status =
          "No API key configured. Append ?opendart_key=YOUR_KEY to the MCP server URL, or pass api_key to each tool. " +
          "Get one free at https://opendart.fss.or.kr/ / " +
          "API 키가 설정되지 않았습니다. MCP 서버 URL 끝에 ?opendart_key=발급키 를 붙이거나 각 도구의 api_key 인자로 넘기세요. " +
          "https://opendart.fss.or.kr/ 에서 무료로 발급받을 수 있습니다.";
      }

      return { content: [{ type: "text" as const, text: status }] };
    }
  );
}

export function registerAllTools(server: McpServer) {
  registerConfigTools(server);         // API key configuration (first)
  registerWorkflowTools(server);       // Workflow tools (most useful)
  registerCompanyTools(server);        // Company search & info
  registerFinancialTools(server);      // Financial statements & indicators
  registerFootingTools(server);        // 풋팅용 간단 조회(토큰 절약)
  registerDisclosureTools(server);     // Periodic report details
  registerShareholdingTools(server);   // Shareholding disclosures
  registerMajorEventTools(server);     // Major corporate events
  registerSecuritiesRegTools(server);  // Securities registration statements
  registerDartDocTools(                // 공시 원문 읽기(dart_find_reports·dart_doc_outline·dart_doc_read)
    server,
    () => resolveApiKey(),
    async (q) => (await searchCompanies(q, undefined, 1))[0]?.corp_code ?? null,
  );
}
