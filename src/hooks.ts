import {
  type ApiRequest,
  type ApiResponse,
  type Context,
  getContext,
} from "iii-sdk";
import { iii } from "./iii.js";

export const useApi = <TBody = unknown>(
  config: {
    api_path: string;
    http_method: string;
    description?: string;
    metadata?: Record<string, unknown>;
  },
  handler: (req: ApiRequest<TBody>, context: Context) => Promise<ApiResponse>,
) => {
  const function_id = `api::${config.http_method.toLowerCase()}::${config.api_path}`;

  iii.registerFunction({ id: function_id, metadata: config.metadata }, (req) =>
    handler(req as ApiRequest<TBody>, getContext()),
  );

  iii.registerTrigger({
    type: "http",
    function_id,
    config: {
      api_path: config.api_path,
      http_method: config.http_method,
      description: config.description,
      metadata: config.metadata,
    },
  });
};

export const useEvent = <TData = unknown>(
  topic: string,
  handler: (data: TData, ctx: Context) => Promise<void>,
  description?: string,
) => {
  const function_id = `event::${topic}::handler`;

  iii.registerFunction({ id: function_id, description }, (data) =>
    handler(data as TData, getContext()),
  );

  iii.registerTrigger({
    type: "subscribe",
    function_id,
    config: { topic },
  });
};

export const emit = async <TData = unknown>(
  topic: string,
  data: TData,
): Promise<void> => {
  iii.triggerVoid("emit", { topic, data });
};

export const useCron = (
  expression: string,
  handler: (ctx: Context) => Promise<void>,
  description?: string,
) => {
  const sanitized = expression.replace(/\s+/g, "_").replace(/\*/g, "x");
  const function_id = `cron::${sanitized}::${Date.now()}`;

  iii.registerFunction({ id: function_id, description }, () =>
    handler(getContext()),
  );

  iii.registerTrigger({
    type: "cron",
    function_id,
    config: { expression },
  });
};
