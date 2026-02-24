import { iii } from "./iii.js";
import type {
  IState,
  StateDeleteInput,
  StateDeleteResult,
  StateGetInput,
  StateListInput,
  StateSetInput,
  StateSetResult,
  StateUpdateInput,
  StateUpdateResult,
} from "iii-sdk/state";

export const state: IState = {
  get: <TData>(input: StateGetInput): Promise<TData | null> =>
    iii.trigger("state::get", input),
  set: <TData>(input: StateSetInput): Promise<StateSetResult<TData> | null> =>
    iii.trigger("state::set", input),
  delete: (input: StateDeleteInput): Promise<StateDeleteResult> =>
    iii.trigger("state::delete", input),
  list: <TData>(input: StateListInput): Promise<TData[]> =>
    iii.trigger("state::list", input),
  update: <TData>(
    input: StateUpdateInput,
  ): Promise<StateUpdateResult<TData> | null> =>
    iii.trigger("state::update", input),
};
