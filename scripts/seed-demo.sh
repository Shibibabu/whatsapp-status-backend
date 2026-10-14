#!/usr/bin/env bash
# Creates demo users with a variety of statuses, and one viewer ("You", +910000000000)
# who has all of them as contacts. Log in to the frontend with that phone number.
set -euo pipefail
API=${API:-http://localhost:3000}
H='content-type: application/json'

user() { # phone name -> id (registers, or logs in if already registered)
  curl -sf "$API/users" -H "$H" -d "{\"phone\":\"$1\",\"name\":\"$2\"}" 2>/dev/null | jq -r .id \
    || curl -sf "$API/users/login" -H "$H" -d "{\"phone\":\"$1\"}" | jq -r .id
}
post() { # userId color text
  curl -sf "$API/statuses" -H "x-user-id: $1" -H "$H" -d "$(jq -nc --arg t "$3" --arg c "$2" '{text:$t,bgColor:$c}')" >/dev/null
}

ME=$(user +910000000000 "You")
contact() { # phone name -> id, and adds them to my contacts
  local id; id=$(user "$1" "$2")
  curl -sf "$API/contacts" -H "x-user-id: $ME" -H "$H" -d "{\"phone\":\"$1\"}" >/dev/null
  echo "$id"
}
ASHA=$(contact +911111111111 Asha)
BILAL=$(contact +912222222222 Bilal)
CHITRA=$(contact +913333333333 Chitra)
DEV=$(contact +914444444444 Dev)

post "$ASHA"   '#2E7D32' 'What a match! India won by 5 wickets 🏏'
post "$ASHA"   '#F59E0B' 'Never give up. Great things take time 💪'
post "$BILAL"  '#D81B60' 'Happy birthday to my little sister 🎂🎉'
post "$BILAL"  '#0277BD' 'Power cut in our area tomorrow 9am to 5pm'
post "$BILAL"  '#FF9800' 'Me: I will sleep early tonight. Also me at 3am: watching cat videos 😂'
post "$CHITRA" '#E91E63' 'Missing you every single day ❤️'
post "$CHITRA" '#5C6BC0' 'Some people leave and never come back… feeling empty'
post "$CHITRA" '#6D4C41' 'Best masala dosa in town, totally worth the wait'
post "$DEV"    '#8E24AA' 'Blessed morning, thank you God 🙏'
post "$DEV"    '#00897B' 'Friends who become family ❤️ miss the gang'
post "$DEV"    '#2E7D32' 'Messi with another stunning free kick ⚽'

echo "Seeded. Log in to the frontend with phone +910000000000"
