clef
1,869
 Downloads
Updated 
yesterday

Clef is a 27B multimodal model created by Cloudflare that turns a state and a schema of typed questions into decisions.
vision
decision
27b
cURL
Python
JavaScript

curl http://localhost:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef",
    "state": "Hello World",
    "questions": {
      "says_hello": {
        "type": "noul",
        "instructions": "Does the state text contain a greeting?",
        "criteria": {
          "true": "The state text contains a greeting.",
          "false": "The state text does not contain a greeting."
        }
      }
    }
  }'
Models
View all →
Name

Size / Usage

Context

Input

clef:latest
18GB

256K

Text, Image

clef:27b
latest
18GB

256K

Text, Image

Readme
Clef requires Ollama 0.35.1 or later.

Clef is a 27B decision model from Cloudflare, fine-tuned from Qwen3.8-27B.

Clef also reads images. Add encoded images to the request and they’re scored jointly with the text.

It’s fully compatible with the Jev and System One APIs, so it works through Ollama’s /v1/systemone endpoint. See clef-flash for a smaller, faster variant.

ollama pull clef
Highlights
Multimodal: Decide over text, JSON, or images — screenshots, receipts, forms, photos.
One forward pass: Every option of every question is scored jointly in a single non-autoregressive pass.
64K context window: Twice the state Jev’s 32K window holds.
Leading accuracy: Clef tops the Decision Index, Cloudflare’s leaderboard of decision models, and beats Jev on most of its suite.
Apache 2.0 license
What you can build
Task	You define	You get back
Route a request	The destinations and when each applies	The chosen destination and each destination’s probability
Check a condition	A yes or no question and the evidence	True or false, and the probability of each
Apply a policy	The rules and the allowed outcomes	A typed decision based on the text or images you supply
Read a document	A photo of the page and the fields to decide	A field-by-field decision with probabilities
API
Decision models use Ollama’s /v1/systemone endpoint, documented here. Put the text you want judged in state and your questions in questions. Ollama builds Clef’s prompt for you.

Field	Description
model	clef
state	The text to judge. Use a string, or a JSON object or array for structured input.
images	Optional. Base64-encoded PNG, JPEG, or WebP images shared by all questions, in request order. URLs and data URLs are not supported.
questions	1 to 64 named questions. Answers come back in the same order.
keep_alive	Optional. How long the model stays loaded after the request.
Every question has a type, instructions, and usually criteria:

Type	criteria	Answer fields
choice	An object mapping each option to a description. Use null to let the option name describe itself. 2 to 26 options.	choice, probabilities, confidence
noul	Optional. {"true": "...", "false": "..."} if you want to describe each side.	noul, the probability that the answer is true
score	An array of level descriptions, lowest first. Levels are numbered from 0. 2 to 26 levels.	score (the probability-weighted level), legend, probabilities, confidence
confidence runs from 0 to 1 and shows how concentrated the probabilities are. It isn’t the chance that the answer is right. If two options tie, the answer follows the model’s option order, so put your preferred option first.

cURL
curl http://localhost:11434/v1/systemone -d '{
  "model": "clef",
  "state": {
    "ticket": "I was charged twice. Please refund the extra payment.",
    "attached": "A screenshot of the customer's bank statement."
  },
  "images": ["<base64-encoded image>"],
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this ticket?",
      "criteria": {
        "billing": "Payments and refunds",
        "technical": "Bugs and integrations",
        "other": "None of the above"
      }
    },
    "refund": {
      "type": "noul",
      "instructions": "Does the customer explicitly ask for a refund?"
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this ticket?",
      "criteria": ["Routine", "Soon", "Urgent"]
    }
  }
}'
{
  "model": "clef",
  "answers": {
    "team": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {"billing": 0.981, "technical": 0.013, "other": 0.006},
      "confidence": 0.924
    },
    "refund": {"type": "noul", "noul": 0.996},
    "urgency": {
      "type": "score",
      "score": 0.704,
      "legend": {"0": "Routine", "1": "Soon", "2": "Urgent"},
      "probabilities": {"0": 0.451, "1": 0.353, "2": 0.196},
      "confidence": 0.071
    }
  },
  "usage": {"input_tokens": 1204, "output_tokens": 3}
}
Python
Use TypeSafe’s official Python SDK and point it at Ollama. The SDK requires an API key, but Ollama ignores it, so any value works.

pip install typesafe-sdk
export TYPESAFE_BASE_URL=http://localhost:11434
export TYPESAFE_API_KEY=ollama
export TYPESAFE_DEFAULT_MODEL=clef
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

questions = {
    "team": Choice(
        instructions="Which team should handle this ticket?",
        criteria={"billing": "Payments and refunds", "technical": "Bugs and integrations", "other": "None of the above"},
    ),
    "refund": Noul(instructions="Does the customer explicitly ask for a refund?"),
    "urgency": Score(instructions="How urgent is this ticket?", criteria=["Routine", "Soon", "Urgent"]),
}

with TypeSafeClient(timeout=120) as client:
    result = client.system_one(state={"ticket": "I was charged twice. Please refund the extra payment."}, questions=questions)

print(result.choices["team"].choice)   # billing
print(result.nouls["refund"].noul)     # 0.996
print(result.scores["urgency"].score)  # 0.70
Decision models aren’t in the Ollama CLI or the Ollama Python and JavaScript libraries yet. Use the API or the TypeSafe SDK for now.

More examples
Images. Send screenshots, receipts, or photos alongside any text state.

curl http://localhost:11434/v1/systemone -d '{
  "model": "clef",
  "state": "Classify each field of the attached receipt.",
  "images": ["<base64-encoded image>"],
  "questions": {
    "total": {"type": "noul", "instructions": "Is the receipt total legible?"},
    "category": {
      "type": "choice",
      "instructions": "What kind of purchase is this?",
      "criteria": {"meals": null, "travel": null, "office": null, "other": null}
    }
  }
}'
Tool call moderation. Check an agent’s tool call before it runs.

curl http://localhost:11434/v1/systemone -d '{
  "model": "clef",
  "state": "send_email(to=\"all-customers\", subject=\"FINAL NOTICE: account will be suspended today\")",
  "questions": {
    "harm": {"type": "noul", "instructions": "Could this tool call cause harm?"}
  }
}'
Benchmarks
Benchmark	Clef	Clef-flash	Jev
BFCL (case exact accuracy)	98.5	98.8	95.8
API-Bank (accuracy)	91.9	93.1	88.2
BANKING77 (macro-F1)	94.2	90.9	79.7
CLINC150+OOS (macro-F1)	97.4	66.8	89.3
Home appliance simulator (case exact accuracy)	83.0	97.7	52.3
ANLI (macro-F1)	69.8	59.1	74.8
RouterBench (selected quality)	79.7	79.9	79.9
PhishNChips (accuracy)	79.6	75.0	62.5
Median latency (ms)	209.3	38.8	524.1
p95 latency (ms)	238.6	122.4	536.0
Decision accuracy on four end-to-end business workflows from Typesafe Evals:

Workflow	Clef	Clef-flash	Jev
Invoice processing	64.7	57.1	61.8
Customer service	76.3	77.0	76.0
Security incidents	62.9	61.7	61.7
Agent trace observability	68.5	69.8	71.6