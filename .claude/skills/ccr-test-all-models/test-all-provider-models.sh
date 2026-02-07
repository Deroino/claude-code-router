#!/bin/bash

# test-all-provider-models.sh
# Test all provider-model combinations and display/save results
# Author: Claude Code (Nekomata Engineer)
# Date: 2026-02-06

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values
CONFIG_FILE="${HOME}/.claude-code-router/config.json"
API_BASE_URL="${API_BASE_URL:-http://localhost:3456}"
API_KEY="${API_KEY:-}"
PARALLEL_JOBS="${PARALLEL_JOBS:-5}"
TIMEOUT="${TIMEOUT:-15}"
TEST_PROMPT="${TEST_PROMPT:-Hello, please respond with 'OK' if you can understand this message.}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
QUERY_PROVIDER="${QUERY_PROVIDER:-}"
QUERY_MODEL="${QUERY_MODEL:-}"

# Temporary files
RESULTS_FILE=$(mktemp)
PROVIDER_MODELS_FILE=$(mktemp)

# Cleanup function (call this at the end)
cleanup() {
    rm -f "$RESULTS_FILE" "$PROVIDER_MODELS_FILE"
}

# Print usage
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Test all provider-model combinations and display/save results.

OPTIONS:
    -c, --config FILE     Path to config.json (default: ~/.claude-code-router/config.json)
    -u, --url URL         API base URL (default: http://localhost:3456)
    -k, --api-key KEY     API key for authentication (if required)
    -j, --jobs NUM        Number of parallel jobs (default: 5)
    -t, --timeout SEC     Request timeout in seconds (default: 15)
    -p, --prompt TEXT     Test prompt message
    -o, --output FILE     Save results to JSON file
    -q, --query P:M       Query specific provider:model details
    -h, --help            Show this help message

EXAMPLES:
    $0                                    # Test with default settings
    $0 -j 10 -t 30                        # 10 parallel jobs, 30s timeout
    $0 -o results.json                    # Save results to JSON file
    $0 -q cli-proxy-api:glm-4.7           # Query specific provider:model

EOF
    exit 0
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -c|--config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        -u|--url)
            API_BASE_URL="$2"
            shift 2
            ;;
        -k|--api-key)
            API_KEY="$2"
            shift 2
            ;;
        -j|--jobs)
            PARALLEL_JOBS="$2"
            shift 2
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -p|--prompt)
            TEST_PROMPT="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        -q|--query)
            QUERY_PROVIDER="${2%:*}"
            QUERY_MODEL="${2#*:}"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo -e "${RED}Error: Unknown option: $1${NC}"
            usage
            ;;
    esac
done

# Query mode: test a single provider-model and show full details
if [[ -n "$QUERY_PROVIDER" && -n "$QUERY_MODEL" ]]; then
    echo -e "${CYAN}Querying: $QUERY_PROVIDER / $QUERY_MODEL${NC}"
    echo ""

    url="${API_BASE_URL}/api/model-test"
    data="{\"provider\":\"$QUERY_PROVIDER\",\"model\":\"$QUERY_MODEL\",\"message\":\"$TEST_PROMPT\"}"

    start_time=$(date +%s%3N)

    response=""
    if [[ -n "$API_KEY" ]]; then
        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $API_KEY" \
            --max-time "$TIMEOUT" \
            -d "$data" \
            "$url" 2>&1) || true
    else
        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            --max-time "$TIMEOUT" \
            -d "$data" \
            "$url" 2>&1) || true
    fi

    end_time=$(date +%s%3N)
    duration_ms=$((end_time - start_time))

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n -1)

    # Build JSON output
    json_output=$(cat << EOF
{
  "provider": "$QUERY_PROVIDER",
  "model": "$QUERY_MODEL",
  "duration_ms": $duration_ms,
  "http_code": $http_code,
  "request": $data,
  "response": $(echo "$body" | jq -c . 2>/dev/null || echo '"$(echo "$body" | sed 's/"/\\"/g' | tr -d '\n')"')
}
EOF
)

    echo "$json_output" | jq .

    # Save to output file if specified
    if [[ -n "$OUTPUT_FILE" ]]; then
        echo "$json_output" | jq . > "$OUTPUT_FILE"
        echo -e "\n${GREEN}Results saved to: $OUTPUT_FILE${NC}"
    fi

    exit 0
fi

# Check if config file exists
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo -e "${RED}Error: Config file not found: $CONFIG_FILE${NC}"
    echo -e "${YELLOW}Make sure Claude Code Router is configured properly.${NC}"
    exit 1
fi

# Extract provider-model pairs from config using nodejs (handles JSON5)
echo -e "${CYAN}Extracting provider-model pairs from config...${NC}"

# Check if node is available
if command -v node &> /dev/null; then
    node -e "
        const fs = require('fs');
        const content = fs.readFileSync('$CONFIG_FILE', 'utf8');
        const json = JSON.parse(content);
        const Providers = json.Providers || [];
        Providers.forEach(p => {
            if (p.name && p.models && Array.isArray(p.models)) {
                p.models.forEach(m => {
                    if (m && m.trim()) {
                        console.log(p.name + '|' + m);
                    }
                });
            }
        });
    " > "$PROVIDER_MODELS_FILE" 2>/dev/null || true
elif command -v python3 &> /dev/null; then
    python3 -c "
import json
import sys

def extract_json5(content):
    lines = []
    in_string = False
    escape_next = False
    in_multiline_comment = False
    in_singleline_comment = False

    for line in content.split('\n'):
        result = []
        i = 0
        while i < len(line):
            char = line[i]

            if escape_next:
                result.append(char)
                escape_next = False
                i += 1
                continue

            if char == '\\\\' and in_string:
                result.append(char)
                escape_next = True
                i += 1
                continue

            if in_multiline_comment:
                if char == '*' and i + 1 < len(line) and line[i + 1] == '/':
                    in_multiline_comment = False
                    i += 2
                else:
                    i += 1
                continue

            if in_singleline_comment:
                i += 1
                continue

            if char == '\"' or char == \"'\":
                in_string = not in_string
                result.append(char)
                i += 1
                continue

            if not in_string:
                if char == '/' and i + 1 < len(line):
                    next_char = line[i + 1]
                    if next_char == '*':
                        in_multiline_comment = True
                        i += 2
                        continue
                    elif next_char == '/':
                        in_singleline_comment = True
                        i += 2
                        continue

                if char == ',' and i + 1 < len(line):
                    next_char = line[i + 1]
                    if next_char in ']} \t\n':
                        i += 1
                        continue

            result.append(char)
            i += 1

        result_str = ''.join(result).strip()
        if result_str and result_str[-1] == ',':
            result_str = result_str[:-1]
        if result_str:
            lines.append(result_str)

    return '\n'.join(lines)

try:
    with open('$CONFIG_FILE', 'r') as f:
        content = f.read()
    clean_content = extract_json5(content)
    data = json.loads(clean_content)
    providers = data.get('Providers', [])
    for p in providers:
        name = p.get('name')
        models = p.get('models', [])
        if name and isinstance(models, list):
            for m in models:
                if m and m.strip():
                    print(f'{name}|{m}')
except Exception as e:
    sys.stderr.write(f'Error: {e}\n')
" > "$PROVIDER_MODELS_FILE" 2>/dev/null || true
else
    echo -e "${RED}Error: Neither node nor python3 is available. Please install one of them.${NC}"
    exit 1
fi

# Check if any providers/models were found
if [[ ! -s "$PROVIDER_MODELS_FILE" ]]; then
    echo -e "${RED}Error: No providers or models found in config file${NC}"
    echo -e "${YELLOW}Please check your config.json and ensure Providers are configured properly.${NC}"
    exit 1
fi

TOTAL_TESTS=$(wc -l < "$PROVIDER_MODELS_FILE")
echo -e "${GREEN}Found $TOTAL_TESTS provider-model combinations to test${NC}"
echo ""

# Function to test a single provider-model
test_single_model() {
    local provider_model="$1"
    local provider="${provider_model%|*}"
    local model="${provider_model#*|}"

    local start_time
    local end_time
    local duration_ms
    local ret_code
    local error_info=""
    local full_response=""

    start_time=$(date +%s%3N)

    local url="${API_BASE_URL}/api/model-test"
    local data="{\"provider\":\"$provider\",\"model\":\"$model\",\"message\":\"$TEST_PROMPT\"}"

    local response
    if [[ -n "$API_KEY" ]]; then
        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $API_KEY" \
            --max-time "$TIMEOUT" \
            -d "$data" \
            "$url" 2>&1) || true
    else
        response=$(curl -s -w "\n%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            --max-time "$TIMEOUT" \
            -d "$data" \
            "$url" 2>&1) || true
    fi

    end_time=$(date +%s%3N)
    duration_ms=$((end_time - start_time))

    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | head -n -1)

    if [[ "$http_code" == "000" ]]; then
        ret_code="ERR"
        error_info="Connection failed or timeout"
        full_response="$body"
    else
        local success
        success=$(echo "$body" | grep -o '"success":[^,}]*' | head -1 | cut -d: -f2 | tr -d ' "')

        if [[ "$success" == "true" ]]; then
            ret_code="200"
        else
            ret_code="$http_code"
            error_info=$(echo "$body" | grep -o '"error":"[^"]*"' | cut -d: -f2- | tr -d '"' | head -c 100)
            if [[ -z "$error_info" || "$error_info" == "null" ]]; then
                error_info=$(echo "$body" | grep -o '"message":"[^"]*"' | cut -d: -f2- | tr -d '"' | head -c 100)
            fi
            if [[ -z "$error_info" || "$error_info" == "null" ]]; then
                error_info=$(echo "$body" | head -c 100)
            fi
            full_response="$body"
        fi
    fi

    if [[ ${#error_info} -gt 50 ]]; then
        error_info="${error_info:0:47}..."
    fi

    # Output to results file (pipe-delimited)
    # Format: provider|model|duration|ret_code|error|http_code|request|response
    echo "$provider|$model|$duration_ms|$ret_code|$error_info|$http_code|$data|$full_response" >> "$RESULTS_FILE"

    local tested_count
    tested_count=$(wc -l < "$RESULTS_FILE" 2>/dev/null || echo 0)
    echo -ne "\r${CYAN}Testing: $tested_count / $TOTAL_TESTS${NC} "
}

export -f test_single_model
export API_BASE_URL API_KEY TIMEOUT TEST_PROMPT RESULTS_FILE
export RED GREEN YELLOW CYAN NC

echo -e "${CYAN}Starting tests with $PARALLEL_JOBS parallel jobs...${NC}"
echo ""

xargs -P "$PARALLEL_JOBS" -I {} bash -c 'test_single_model "{}"' < "$PROVIDER_MODELS_FILE"

echo ""
echo -e "${GREEN}All tests completed!${NC}"
echo ""

# Read and sort results
results=$(sort "$RESULTS_FILE")

# Calculate statistics
total=$(echo "$results" | wc -l)
success=$(echo "$results" | awk -F'|' '$4 == "200"' | wc -l)
failed=$((total - success))
avg_duration=$(echo "$results" | awk -F'|' '{sum+=$3; count++} END {if(count>0) printf "%.0f", sum/count; else print 0}')

# Print summary
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}                      TEST SUMMARY                            ${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "  Total Tests:     ${YELLOW}$total${NC}"
echo -e "  Successful:      ${GREEN}$success${NC}"
echo -e "  Failed:          ${RED}$failed${NC}"
echo -e "  Success Rate:    ${YELLOW}$(awk "BEGIN {printf \"%.1f\", ($success/$total)*100}")%${NC}"
echo -e "  Avg Duration:    ${YELLOW}${avg_duration}ms${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# Print results table
echo -e "${CYAN}DETAILED RESULTS:${NC}"
echo ""

printf "${CYAN}%-30s %-30s %10s %8s %s${NC}\n" "Provider" "Model" "Duration" "Status" "Error Info"
printf "${CYAN}%.30s %.30s %10s %8s %s${NC}\n" "------------------------------" "------------------------------" "----------" "--------" "--------------------------------------------------"

while IFS='|' read -r provider model duration ret_code error_info rest; do
    duration_formatted="${duration}ms"
    status_color="$NC"
    status_display="$ret_code"

    if [[ "$ret_code" == "200" ]]; then
        status_color="$GREEN"
        status_display="OK"
    elif [[ "$ret_code" == "ERR" ]]; then
        status_color="$RED"
        status_display="ERR"
    else
        status_color="$YELLOW"
        status_display="$ret_code"
    fi

    printf "%-30s %-30s %10s ${status_color}%-8s${NC} %s\n" \
        "$provider" \
        "$model" \
        "$duration_formatted" \
        "$status_display" \
        "$error_info"
done <<< "$results"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"

# Save results to JSON file if specified
if [[ -n "$OUTPUT_FILE" ]]; then
    echo ""
    echo -e "${CYAN}Saving results to JSON file...${NC}"

    # Build JSON array
    json_array="["
    first=true

    while IFS='|' read -r provider model duration ret_code error_info http_code request_body response_body; do
        if [[ "$first" == "true" ]]; then
            first=false
        else
            json_array+=","
        fi

        # Escape strings for JSON
        provider_json=$(echo "$provider" | sed 's/"/\\"/g')
        model_json=$(echo "$model" | sed 's/"/\\"/g')

        # Try to parse response as JSON, otherwise escape as string
        if [[ -z "$response_body" ]]; then
            response_json="\"\""
        elif command -v jq &> /dev/null; then
            response_json=$(echo "$response_body" | jq -c . 2>/dev/null || echo "\"$(echo "$response_body" | sed 's/"/\\"/g' | tr -d '\n' | head -c 2000)\"")
        else
            response_json="\"$(echo "$response_body" | sed 's/"/\\"/g' | tr -d '\n' | head -c 2000)\""
        fi

        json_array+="{\"provider\":\"$provider_json\",\"model\":\"$model_json\",\"duration_ms\":$duration,\"http_code\":$http_code,\"request\":$request_body,\"response\":$response_json}"
    done < "$RESULTS_FILE"

    json_array+="]"

    # Write to file
    echo "$json_array" | jq . > "$OUTPUT_FILE" 2>/dev/null || echo "$json_array" > "$OUTPUT_FILE"

    echo -e "${GREEN}Results saved to: $OUTPUT_FILE${NC}"
fi

# Exit with non-zero if any tests failed
exit_code=0
if [[ $failed -gt 0 ]]; then
    exit_code=1
fi

# Cleanup temporary files
cleanup
rm -f "$DETAILS_FILE"

exit $exit_code