#!/bin/zsh

set -u

query="${1:-}"
service="jp.random-walk.omniplan.capture"
account_token="alfred-token"
account_url="alfred-url"
cache_root="${alfred_workflow_cache:-${TMPDIR%/}/omniplan-alfred}"
outbox="${cache_root}/outbox"
mkdir -p "$outbox"
chmod 700 "$cache_root" "$outbox" 2>/dev/null || true

capture_url=$(/usr/bin/security find-generic-password -s "$service" -a "$account_url" -w 2>/dev/null || true)
capture_token=$(/usr/bin/security find-generic-password -s "$service" -a "$account_token" -w 2>/dev/null || true)

send_payload() {
  local key="$1"
  local payload="$2"
  local response_file="${cache_root}/response-${key}.json"
  http_code=$(/usr/bin/curl --silent --show-error --max-time 8 \
    --output "$response_file" --write-out "%{http_code}" \
    --request POST "${capture_url%/}/api/captures" \
    --header "Authorization: Bearer ${capture_token}" \
    --header "Content-Type: application/json" \
    --header "Idempotency-Key: ${key}" \
    --data-binary "$payload" 2>/dev/null)
  curl_status=$?
  response_body=""
  if [[ -f "$response_file" ]]; then
    response_body=$(<"$response_file")
    /bin/rm -f "$response_file"
  fi
}

queue_payload() {
  local key="$1"
  local payload="$2"
  local target="${outbox}/${key}.json"
  /usr/bin/printf '%s' "$payload" > "$target"
  chmod 600 "$target" 2>/dev/null || true
}

if [[ "$query" == "!retry" ]]; then
  if [[ -z "$capture_url" || -z "$capture_token" ]]; then
    /usr/bin/printf '%s' "尚未配置服务地址或 Token。"
    exit 0
  fi
  retried=0
  remaining=0
  for queued in "$outbox"/*.json(N); do
    key="${queued:t:r}"
    payload=$(<"$queued")
    send_payload "$key" "$payload"
    if [[ "$curl_status" -eq 0 && ("$http_code" == "200" || "$http_code" == "201") ]]; then
      /bin/rm -f "$queued"
      (( retried += 1 ))
    else
      (( remaining += 1 ))
    fi
  done
  /usr/bin/printf '%s' "已重试 ${retried} 条；仍排队 ${remaining} 条。"
  exit 0
fi

trimmed="${query//[[:space:]]/}"
if [[ -z "$trimmed" ]]; then
  /usr/bin/printf '%s' "输入标题；可用：标题 | 备注 | 2026-09-16 15:00 | 30m"
  exit 0
fi

payload=$(/usr/bin/osascript -l JavaScript "${0:A:h}/capture-payload.js" "$query" 2>/dev/null)
if [[ $? -ne 0 || -z "$payload" ]]; then
  /usr/bin/printf '%s' "输入无法解析，请检查日期或工作量。"
  exit 0
fi

idempotency_key="alfred-$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
if [[ -z "$capture_url" || -z "$capture_token" ]]; then
  queue_payload "$idempotency_key" "$payload"
  /usr/bin/printf '%s' "未配置连接；已保存在本机队列。运行 setup-alfred.zsh 后输入 oa !retry。"
  exit 0
fi

send_payload "$idempotency_key" "$payload"
if [[ "$curl_status" -eq 0 && "$http_code" == "201" ]]; then
  /usr/bin/printf '%s' "已接收；稍后会进入 OmniPlan 收件箱。"
elif [[ "$curl_status" -eq 0 && "$http_code" == "200" && "$response_body" == *'"status":"duplicate"'* ]]; then
  /usr/bin/printf '%s' "重复请求已忽略；原任务仍然有效。"
elif [[ "$http_code" == "400" || "$http_code" == "401" || "$http_code" == "403" || "$http_code" == "413" ]]; then
  /usr/bin/printf '%s' "服务拒绝了请求（${http_code}），请检查 Token 或输入。"
else
  queue_payload "$idempotency_key" "$payload"
  /usr/bin/printf '%s' "网络不可用；已安全排队。输入 oa !retry 重试。"
fi
