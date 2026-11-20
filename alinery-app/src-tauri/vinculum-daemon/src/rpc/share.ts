import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { ShareService } from "alinery-proto/alinery/v1/share_pb";
import { armTeamShare, clearTeamShare, writeShareFile } from "../domain/teamShare.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

export function shareService(repo: string, dedupe: Dedupe): ServiceImpl<typeof ShareService> {
  return {
    setShare: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(() => {
          const teamId = req.teamId.trim();
          const name = req.name.trim();
          const token = req.token.trim();
          const accounts = req.accountsUrl.trim().replace(/\/$/, "");
          const loopback = accounts.startsWith("http://localhost") || accounts.startsWith("http://127.0.0.1");
          if (!teamId || !name || !token.startsWith("sync_") || !(accounts.startsWith("https://") || loopback)) {
            throw fail(Code.InvalidArgument, "invalid_argument", "share needs a team, a name, a sync token and an https accounts url");
          }
          writeShareFile(repo, { team_id: teamId, name, token, accounts_url: accounts });
          armTeamShare(repo);
          return {};
        }),
      );
    },
    clearShare: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => domain(() => clearTeamShare(repo)));
    },
  };
}
