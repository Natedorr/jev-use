clef-flash
3,340
 Downloads
Updated 
yesterday

Clef-Flash is a 9B multimodal model that turns a state and a schema of typed questions into decisions.
vision
decision
9b
cURL
Python
JavaScript

curl http://localhost:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "clef-flash",
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

clef-flash:latest
11GB

256K

Text, Image

clef-flash:9b
latest
11GB

256K

Text, Image

Readme
Clef Flash requires Ollama 0.35.1 or later.

Clef Flash is a 9B decision model from Cloudflare, fine-tuned from Qwen3.5-9B.

Clef Flash can also read images: add encoded images to the request and they’re scored jointly with the text state.

It’s fully compatible with the Jev and System One APIs, so it works through Ollama’s /v1/systemone endpoint. Use Clef Flash for latency-critical decisions; see clef for the larger, more accurate variant.

ollama pull clef-flash
Highlights
Fast: Clef Flash had the lowest measured latency of any decision model in Cloudflare’s Decision Index runs — the 27B Clef is roughly five times slower.
Multimodal: Decide over text, JSON, or images — screenshots, receipts, forms, photos.
One forward pass: Every option of every question is scored jointly in a single non-autoregressive pass.
64K context window: Twice the state Jev’s 32K window holds.
Apache 2.0 license
What you can build
Task	You define	You get back
Route a request	The destinations and when each applies	The chosen destination and each destination’s probability
Check a condition	A yes or no question and the evidence	True or false, and the probability of each
Apply a policy	The rules and the allowed outcomes	A typed decision based on the text or images you supply
Gate an agent step	A condition and the agent’s proposed tool call	Go or no-go, with the probability of each
API
Decision models use Ollama’s /v1/systemone endpoint, documented here. Put the text you want judged in state and your questions in questions. Ollama builds Clef Flash’s prompt for you.

Field	Description
model	clef-flash
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
  "model": "clef-flash",
  "state": "Checkout has been failing for every customer for the last hour.",
  "questions": {
    "urgent": {"type": "noul", "instructions": "Is this support request urgent?"},
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this request?",
      "criteria": {
        "billing": "Payments, invoices, and refunds",
        "technical": "Outages, errors, and configuration",
        "sales": "Plans and upgrades"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is the customer impact?",
      "criteria": ["No impact", "Minor", "Major", "Critical"]
    }
  }
}'
{
  "model": "clef-flash",
  "answers": {
    "urgent": {"type": "noul", "noul": 0.998},
    "team": {
      "type": "choice",
      "choice": "technical",
      "probabilities": {"billing": 0.004, "technical": 0.992, "sales": 0.004},
      "confidence": 0.947
    },
    "severity": {
      "type": "score",
      "score": 2.851,
      "legend": {"0": "No impact", "1": "Minor", "2": "Major", "3": "Critical"},
      "probabilities": {"0": 0.002, "1": 0.014, "2": 0.271, "3": 0.713},
      "confidence": 0.631
    }
  },
  "usage": {"input_tokens": 486, "output_tokens": 3}
}
Python
Use TypeSafe’s official Python SDK and point it at Ollama. The SDK requires an API key, but Ollama ignores it, so any value works.

pip install typesafe-sdk
export TYPESAFE_BASE_URL=http://localhost:11434
export TYPESAFE_API_KEY=ollama
export TYPESAFE_DEFAULT_MODEL=clef-flash
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

questions = {
    "urgent": Noul(instructions="Is this support request urgent?"),
    "team": Choice(
        instructions="Which team should handle this request?",
        criteria={"billing": "Payments, invoices, and refunds", "technical": "Outages, errors, and configuration", "sales": "Plans and upgrades"},
    ),
    "severity": Score(instructions="How severe is the customer impact?", criteria=["No impact", "Minor", "Major", "Critical"]),
}

with TypeSafeClient(timeout=120) as client:
    result = client.system_one(state="Checkout has been failing for every customer for the last hour.", questions=questions)

print(result.nouls["urgent"].noul)     # 0.998
print(result.choices["team"].choice)   # technical
print(result.scores["severity"].score) # 2.85
Decision models aren’t in the Ollama CLI or the Ollama Python and JavaScript libraries yet. Use the API or the TypeSafe SDK for now.

More examples
Images. Gate agent actions on what’s in the frame.

curl http://localhost:11434/v1/systemone -d '{
  "model": "clef-flash",
  "state": "The agent wants to submit the attached form.",
  "images": ["<base64-encoded image>"],
  "questions": {
    "complete": {"type": "noul", "instructions": "Are all required fields filled in?"},
    "type": {
      "type": "choice",
      "instructions": "What kind of document is this?",
      "criteria": {"invoice": null, "receipt": null, "contract": null, "other": null}
    }
  }
}'
Model routing. Send each prompt to the model that fits it.

curl http://localhost:11434/v1/systemone -d '{
  "model": "clef-flash",
  "state": "Design a sharded database schema for a payments ledger.",
  "questions": {
    "model": {
      "type": "choice",
      "instructions": "Which model should answer this prompt?",
      "criteria": {"gemma4": "Small model", "gpt-6": "Large model"}
    }
  }
}'
Benchmarks
Benchmark	Clef-flash	Clef	Jev
BFCL (case exact accuracy)	98.8	98.5	95.8
API-Bank (accuracy)	93.1	91.9	88.2
BANKING77 (macro-F1)	90.9	94.2	79.7
CLINC150+OOS (macro-F1)	66.8	97.4	89.3
Home appliance simulator (case exact accuracy)	97.7	83.0	52.3
ANLI (macro-F1)	59.1	69.8	74.8
RouterBench (selected quality)	79.9	79.7	79.9
When2Call (accuracy)	65.6	72.4	81.0
Median latency (ms)	38.8	209.3	524.1
p95 latency (ms)	122.4	238.6	536.0
Decision accuracy on four end-to-end business workflows from Typesafe Evals:

Workflow	Clef-flash	Clef	Jev
Invoice processing	57.1	64.7	61.8
Customer service	77.0	76.3	76.0
Security incidents	61.7	62.9	61.7
Agent trace observability	69.8	68.5	71.6