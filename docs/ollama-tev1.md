tev1
25.2K
 Downloads
Updated 
2 days ago

A 4B decision model from Together AI for fast classification.
tools
decision
thinking
0.8b
4b
cURL
Python
JavaScript

curl http://localhost:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tev1",
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

tev1:latest
4.4GB - 4.5GB

256K

Text

tev1:0.8b
797MB - 812MB

256K

Text

tev1:4b
latest
4.4GB - 4.5GB

256K

Text

Readme
Tev1 requires Ollama 0.35 or later.

Tev1 is a family of experimental decision models from Together AI, fine-tuned from Qwen3.5 in 4B and 0.8B sizes.

You give it a question and a set of options. It selects the answer based on likely outcome, and gives you the probability of each option.

It’s meant for the fast classification work that TypeSafe’s Jev does, like routing a support ticket or checking a request against a policy.

Models
4B

ollama pull tev1:4b
0.8B

ollama pull tev1:0.8b
Highlights
Three question types: Pick from a list, answer true or false, or place something on a rubric.
Two sizes: The 4B model is the more accurate of the two. The 0.8B model is an 812MB download for tight memory budgets.
Many questions per request: Ask up to 64 questions about the same text in one call.
Open: The dataset builders and training scripts are MIT licensed.
API
Decision models use Ollama’s /v1/systemone endpoint, which follows TypeSafe’s Jev API. Put the text you want judged in state and your questions in questions. Ollama builds Tev1’s prompt for you.

Field	Description
model	tev1 (the 4B model) or tev1:0.8b
state	The text to judge. Use a string, or a JSON object or array for structured input.
questions	1 to 64 named questions. Answers come back in the same order.
keep_alive	Optional. How long the model stays loaded after the request.
Every question has a type, instructions, and usually criteria:

Type	criteria	Answer fields
choice	An object mapping each option to a description. Use null to let the option name describe itself.	choice, probabilities, confidence
noul	Optional. {"true": "...", "false": "..."} if you want to describe each side.	noul, the probability that the answer is true
score	An array of level descriptions, lowest first. Levels are numbered from 0.	score (the probability-weighted level), legend, probabilities, confidence
Choice and score questions take 2 to 26 options. Tev1 was trained on 2 to 24, so stay in that range. confidence runs from 0 to 1 and shows how concentrated the probabilities are. It isn’t the chance that the answer is right.

Examples
cURL
curl http://localhost:11434/v1/systemone -d '{
  "model": "tev1",
  "state": "Customer message: Hi, I checked my statement and your company charged my card twice for the October subscription. The amounts are both $19.99 on the same day. I have not changed my plan.",
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "Which listed support intent best matches the customer message?",
      "criteria": {
        "duplicate_charge": "The customer reports being charged more than once.",
        "cancel_subscription": "The customer wants to end or downgrade a subscription.",
        "card_declined": "The customer reports a payment that failed or was declined.",
        "none": "None of the listed intents matches."
      }
    },
    "refund": {
      "type": "noul",
      "instructions": "Does the customer explicitly ask for a refund?"
    }
  }
}'
The response has an entry under answers for each question. intent comes back with the chosen choice, the probabilities of all four options, and a confidence. refund comes back as noul, the probability that the answer is true.

To use the smaller model, set "model": "tev1:0.8b".

Python
Use TypeSafe’s official Python SDK and point it at Ollama. The SDK requires an API key, but Ollama ignores it, so any value works.

pip install typesafe-sdk
export TYPESAFE_BASE_URL=http://localhost:11434
export TYPESAFE_API_KEY=ollama
export TYPESAFE_DEFAULT_MODEL=tev1
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

state = {
    "policy": "Returns are allowed within 30 days of purchase.",
    "request": "I bought these headphones 12 days ago and want to send them back.",
}
questions = {
    "eligible": Noul(
        instructions="Is this return within the allowed window?",
    ),
    "category": Choice(
        instructions="What kind of request is this?",
        criteria={
            "return": "The customer wants to send an item back.",
            "exchange": "The customer wants a different item instead.",
            "other": "None of the above.",
        },
    ),
    "sentiment": Score(
        instructions="How positive is the customer's message?",
        criteria=["Negative", "Neutral", "Positive"],
    ),
}

with TypeSafeClient(timeout=120) as client:
    result = client.system_one(state=state, questions=questions)

print(result.nouls["eligible"].noul)          # probability the return is allowed
print(result.choices["category"].choice)      # the chosen category
print(result.scores["sentiment"].score)       # expected level, from 0 to 2
Decision models aren’t in the Ollama CLI or the Ollama Python and JavaScript libraries yet. Use the API or the TypeSafe SDK for now.

Evaluation
On Ollama
Mean accuracy across Bespoke Labs’ 13 public datasets with human labels, 3,880 decisions in all. Tev1 and Nimble ran on Ollama. The Jev result is from Bespoke Labs’ own run of the same decisions through TypeSafe’s API.

Model	From	Accuracy
Tev1 4B	Together AI	73.3%
Tev1 0.8B	Together AI	63.5%
Nimble 9B	Bespoke Labs	75.7%
Jev 1.13	TypeSafe	76.0%
Together AI results
These are Together AI’s development numbers for Tev1 4B, run on Together AI at temperature 0 with thinking off.

Evaluation	Correct	Accuracy
Main decision set	880 / 1,000	88.0%
Policy transfer	300 / 300	100%
Valid single-letter answers	1,300 / 1,300	100%
The same eval mix was used while the model was being built, so it isn’t an independent benchmark. The policy transfer set is built from synthetic policies.

Training data
Tev1 4B is a fine-tune of Qwen3.5-4B on 37,840 examples. Every source was converted into the same state, question, options format. Tev1 0.8B is a fine-tune of Qwen3.5-0.8B from the same project.

Source	Decision	Examples
MultiNLI	Supports, contradicts, or neutral	5,000
BoolQ	Yes or no, using a passage	3,000
Banking77	Pick a banking intent	3,000
AG News	Classify a news item	1,500
SST-5	Pick a sentiment level	2,000
Programmatic policies	Apply a rule	13,500
Routing	Route by priority rules	6,000
Research taxonomy	Classify a research paper	3,840
Total		37,840
Tev1 takes its inspiration from Jev. None of its training data came from Jev.

Notes
Use /v1/systemone. In a regular chat, Tev1 tends to reply in prose.
Keep inputs short. Every question is scored with the full state and question set in its prompt, and Tev1 runs with a context of about 2,000 tokens. The longest training example is about 1,500 tokens.
If none of your options might fit, add a none option.
It can be wrong. Don’t let it be the only check on a high-stakes decision.
Together AI hasn’t fully tested prompt injection, languages other than English, calibration, or how it handles inputs unlike its training data.
Request bodies can be up to 64 KiB.
Reference
Ollama blog
How to train your own Jev for $17
GitHub: togethercomputer/tev1
Hugging Face: Tev1-4B-experimental
Hugging Face: Tev1-0.8B-experimental