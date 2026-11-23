-- Usage rows for the build subagent (17bf6ba5-55c2-4a1b-aa92-eeb04796c909) and the parent session (1807218b-1706-4a87-a75f-8de82d47ff6e) of hidden-spec-cli-01-run-20261122.
-- Saved as muse-usage.jsonl (one JSON object per row) next to this file, then used for the bundle.
SELECT u.agent_id AS agent_id, u.message_id AS message_id, u.input_tokens AS input_tokens, u.output_tokens AS output_tokens, u.created_at AS created_at FROM agent.agent_message_token_usage u WHERE u.agent_id IN ('17bf6ba5-55c2-4a1b-aa92-eeb04796c909', '1807218b-1706-4a87-a75f-8de82d47ff6e') ORDER BY u.created_at ASC
