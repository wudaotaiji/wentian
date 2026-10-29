# Wentian Gatewayを実行するためのNode.jsイメージです。
FROM node:22-alpine

WORKDIR /app

# 依存関係を先に配置し、ソース変更時のビルドキャッシュを有効活用します。
COPY package.json package-lock.json ./
RUN npm ci

# TypeScriptはtsxで直接実行するため、実行に必要なソースと設定だけを配置します。
# 外部エージェントの動的選択では agent-selection.json を実行時に参照します。
# ローカル開発とコンテナで同じ選択ポリシーを使用できるよう、設定を明示的に同梱します。
COPY tsconfig.json providers.json agent-selection.json wentian.plugins.json ./
COPY src ./src
COPY bin ./bin

# root権限を使わず、永続化領域だけを外部ボリュームへ書き込みます。
RUN mkdir -p /app/.wentian && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8787 \
    WENTIAN_HOST=0.0.0.0 \
    WENTIAN_INSTALL_ROOT=/app \
    WENTIAN_TASK_ROOT=/app/.wentian/tasks \
    WENTIAN_EVENT_STORE=/app/.wentian/events.jsonl

EXPOSE 8787
CMD ["npm", "run", "start"]
