nimble
23.6K
 Downloads
Updated 
yesterday

A 9B decision model from Bespoke Labs for fast, typed classification.
tools
decision
thinking
9b
cURL
Python
JavaScript

curl http://localhost:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nimble",
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

nimble:latest
9.3GB - 9.5GB

256K

Text

nimble:9b
latest
9.3GB - 9.5GB

256K

Text

Readme
Nimble requires Ollama 0.35 or later.

Nimble is a 9B decision model from Bespoke Labs, fine-tuned from Qwen3.5-9B.

You send Nimble some text and a set of questions. It picks an answer for every question and gives you the probability of each allowed answer. Nimble reads the prompt once per question and scores the answer tokens directly.

There’s no reasoning step. This is what makes it fast.

ollama pull nimble
Highlights
Three question types: Pick from a list, answer true or false, or place something on a rubric.
Many questions per request: Ask up to 64 questions about the same text in one call.
Fast: Nimble answers in under 100ms on a MacBook Pro with an M5 Max.
Trained on contrastive pairs: The two examples in a pair differ by one fact, and that fact flips the answer.
Apache 2.0 license
What you can build
Task	You define	You get back
Route a request	The destinations and when each one applies	The chosen destination and the probability of each destination
Check a condition	A yes or no question and the evidence	True or false, and the probability of each
Apply a policy	The rules and the allowed outcomes	A typed decision based on the text you supply
Rate an outcome	Ordered levels, each with clear criteria	The chosen level and the probability of each level
API
Decision models use Ollama’s /v1/systemone endpoint, which follows TypeSafe’s Jev API. Put the text you want judged in state and your questions in questions. Ollama builds Nimble’s prompt for you.

Field	Description
model	nimble
state	The text to judge. Use a string, or a JSON object or array for structured input.
questions	1 to 64 named questions. Answers come back in the same order.
keep_alive	Optional. How long the model stays loaded after the request.
Every question has a type, instructions, and usually criteria:

Type	criteria	Answer fields
choice	An object mapping each option to a description. Use null to let the option name describe itself.	choice, probabilities, confidence
noul	Optional. {"true": "...", "false": "..."} if you want to describe each side.	noul, the probability that the answer is true
score	An array of level descriptions, lowest first. Levels are numbered from 0.	score (the probability-weighted level), legend, probabilities, confidence
Choice and score questions take 2 to 26 options. confidence runs from 0 to 1 and shows how concentrated the probabilities are. It isn’t the chance that the answer is right.

Examples
cURL
curl http://localhost:11434/v1/systemone -d '{
  "model": "nimble",
  "state": {
    "ticket": "I was charged twice. Please refund the extra payment."
  },
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
Output
{
  "model": "nimble",
  "answers": {
    "team": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {"billing": 0.984, "technical": 0.011, "other": 0.005},
      "confidence": 0.918
    },
    "refund": {"type": "noul", "noul": 0.997},
    "urgency": {
      "type": "score",
      "score": 0.693,
      "legend": {"0": "Routine", "1": "Soon", "2": "Urgent"},
      "probabilities": {"0": 0.482, "1": 0.342, "2": 0.175},
      "confidence": 0.068
    }
  },
  "usage": {"input_tokens": 841, "output_tokens": 3}
}
Python
Use TypeSafe’s official Python SDK and point it at Ollama. The SDK requires an API key, but Ollama ignores it, so any value works.

pip install typesafe-sdk
export TYPESAFE_BASE_URL=http://localhost:11434
export TYPESAFE_API_KEY=ollama
export TYPESAFE_DEFAULT_MODEL=nimble
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

ticket = "I was charged twice. Please refund the extra payment."
questions = {
    "team": Choice(
        instructions="Which team should handle this ticket?",
        criteria={
            "billing": "Payments and refunds",
            "technical": "Bugs and integrations",
            "other": "None of the above",
        },
    ),
    "refund": Noul(
        instructions="Does the customer explicitly ask for a refund?",
    ),
    "urgency": Score(
        instructions="How urgent is this ticket?",
        criteria=["Routine", "Soon", "Urgent"],
    ),
}

with TypeSafeClient(timeout=120) as client:
    result = client.system_one(
        state={"ticket": ticket},
        questions=questions,
    )

print(result.choices["team"].choice)   # billing
print(result.nouls["refund"].noul)     # 0.997
print(result.scores["urgency"].score)  # 0.69
Decision models aren’t in the Ollama CLI or the Ollama Python and JavaScript libraries yet. Use the API or the TypeSafe SDK for now.

More examples
Ticket triage. With null descriptions, the option names describe themselves.

curl http://localhost:11434/v1/systemone -d '{
  "model": "nimble",
  "state": "Our checkout has returned 500 errors since 9am.",
  "questions": {
    "label": {
      "type": "choice",
      "instructions": "Which label fits this ticket?",
      "criteria": {"billing": null, "bug": null, "account": null}
    }
  }
}'
Model routing. Send each prompt to the model that fits it.

curl http://localhost:11434/v1/systemone -d '{
  "model": "nimble",
  "state": "Design a sharded database schema for a payments ledger.",
  "questions": {
    "model": {
      "type": "choice",
      "instructions": "Which model should answer this prompt?",
      "criteria": {"gemma4": "Small model", "gpt-6": "Large model"}
    }
  }
}'
Tool call moderation. Check an agent’s tool call before it runs.

curl http://localhost:11434/v1/systemone -d '{
  "model": "nimble",
  "state": "run_shell(command=\"rm -rf ~\")",
  "questions": {
    "harm": {
      "type": "noul",
      "instructions": "Could this tool call cause harm?"
    }
  }
}'
Evaluation
On Ollama
Mean accuracy across Bespoke Labs’ 13 public datasets with human labels, 3,880 decisions in all. Nimble and Tev1 ran on Ollama. The Jev result is from Bespoke Labs’ own run of the same decisions through TypeSafe’s API.

Model	From	Accuracy
Nimble 9B	Bespoke Labs	75.7%
Tev1 4B	Together AI	73.3%
Tev1 0.8B	Together AI	63.5%
Jev 1.13	TypeSafe	76.0%
Bespoke Labs results
The numbers below come from Bespoke Labs and were measured on the original Nimble release.

Held-out set
Bespoke Labs held back 324 examples (162 contrastive pairs) from training to test on.

Model	Reference matches	Agreement
Gemma 3 270M IT	93 / 324	28.70%
Qwen3.5-0.8B	147 / 324	45.37%
Qwen3.5-4B	199 / 324	61.42%
Qwen3.5-9B (base model)	215 / 324	66.36%
Qwen3.8-27B	275 / 324	84.88%
Bespoke Nimble 9B	292 / 324	90.12%
Jev 1.13.0	302 / 324	93.21%
Public benchmarks
To test outside its own data, Bespoke Labs ran Nimble and Jev 1.13.0 on the same 3,880 records from 13 public datasets. People wrote the labels, and none of the tasks fall in Nimble’s training categories.

Subset	Task	Type	Nimble 9B	Jev 1.13.0
massive-en-US	Intent routing	Choice	86.9%	87.4%
massive-de-DE	Multilingual routing	Choice	83.4%	86.9%
multinli	Entailment	Choice	85.3%	82.9%
pubmedqa	Medical question answering	Choice	75.6%	77.2%
vitaminc-dev	Contrastive fact verification	Choice	76.6%	80.1%
boolq	Yes or no over a passage	Boolean	86.0%	89.7%
squad2	RAG answerability	Boolean	80.6%	82.9%
paws	Paraphrase detection	Boolean	82.8%	89.2%
civil_comments	Moderation	Boolean	70.3%	81.0%
aegis2	Prompt safety guardrails	Boolean	81.2%	80.4%
helpsteer2	Response quality rubric	Score	39.0%	34.1%
summeval-relevance	Summary relevance	Score	49.2%	35.0%
summeval-consistency	Summary consistency	Score	75.7%	81.2%
Average	Nimble 9B	Jev 1.13.0
All 13 subsets (macro)	74.8%	76.0%
Choice	81.6%	82.9%
Boolean	80.2%	84.6%
Score	54.6%	50.1%
Accuracy means agreement with the human label. On the rubric subsets, it only counts when the top level matches the human level exactly, which is why some of those numbers run low for both models.

Training
Contrastive data curation
Bespoke Labs builds the training data in pairs. The two examples in a pair are the same except for one fact. Change that fact and the right answer flips. From these pairs the model learns which evidence should change its decision.

Evidence	First example	Changed example
Who can approve refunds	Only Mira may authorize refunds for account 42.	Unchanged
Authorization record	The sole authorization for this refund on account 42 was signed by Mira.	The sole authorization for this refund on account 42 was signed by Noah.
Is the refund authorized?	true	false
Before a pair is kept, separate model calls check it. The facts have to agree with the policy, and the text can’t give away the answer. Dropping either evidence sentence has to leave the deciding fact unknown. The labels come from running the checked rules in code.

Notes
Text only.
Nimble can only pick from the answers you give it. It won’t write explanations, nested JSON, or quotes pulled from the context.
Questions are scored independently. If two answers need to agree, check that in your code.
A probability of 0.9 doesn’t mean the answer is right 90% of the time on your data. Test any threshold on your own data before you rely on it.
If none of your answers might fit, add a “no match” choice.
Every question is scored with the full state and question set in its prompt, and that prompt has to fit in Nimble’s 8,192-token context. Shorter prompts are better tested.
Request bodies can be up to 64 KiB.
Reference
Ollama blog
GitHub: bespokelabsai/nimble
Hugging Face: Bespoke-Nimble-9B
Public benchmarks
Bespoke Labs