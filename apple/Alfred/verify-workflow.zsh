#!/bin/zsh

set -euo pipefail

workflow_path="${1:-${0:A:h}/OmniPlan Add Action/info.plist}"
workflow_dir="${workflow_path:h}"
script_uid="B906A9AE-3C1C-4D37-A2D8-4AB091CCDF52"
feedback_trigger_id="capture-feedback"

/usr/bin/plutil -convert json -o - "$workflow_path" |
  /usr/bin/jq -e \
    --arg script_uid "$script_uid" \
    --arg feedback_trigger_id "$feedback_trigger_id" '
    ([.objects[] | select(.type == "alfred.workflow.output.notification")][0]) as $notification
    | ([.objects[]
        | select(
            .type == "alfred.workflow.trigger.external"
              and .config.triggerid == $feedback_trigger_id
              and .config.availableviaurlhandler == true
          )][0]) as $feedback_trigger
    | ($notification.uid // "") as $notification_uid
    | ($feedback_trigger.uid // "") as $feedback_trigger_uid
    | ($notification_uid != "")
      and ($feedback_trigger_uid != "")
      and ($notification.config.onlyshowifquerypopulated == true)
      and any(.connections[$script_uid][]?; .destinationuid == $notification_uid)
      and any(.connections[$feedback_trigger_uid][]?; .destinationuid == $notification_uid)
      and any(
        .objects[];
        .uid == $script_uid
          and (.config.script | contains("capture.zsh"))
      )
  ' >/dev/null

test -x "$workflow_dir/capture.zsh"
test -f "$workflow_dir/capture-payload.js"
/usr/bin/grep -q '/api/captures' "$workflow_dir/capture.zsh"
/usr/bin/grep -q 'Idempotency-Key' "$workflow_dir/capture.zsh"
if /usr/bin/grep -q 'omniplan-companion://' "$workflow_path"; then
  /usr/bin/printf '%s\n' "Legacy Companion URL remains in workflow." >&2
  exit 1
fi
