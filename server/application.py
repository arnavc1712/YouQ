import json
from flask import Flask, request, Response
from flask_cors import CORS, cross_origin
from youtube_transcript_api import YouTubeTranscriptApi, _errors
from langchain.embeddings import OpenAIEmbeddings
from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler
import pinecone
import openai
import time
import threading
import queue
import os

MODEL_NAME = "gpt-3.5-turbo"
MAX_CHUNK_SIZE = 300
OVERLAP_SIZE = 100

# pinecone stuff
PINECONE_API_KEY = os.environ.get('PINECONE_API_KEY')
PINECONE_ENVIRONMENT = os.environ.get('PINECONE_ENVIRONMENT')
TABLE_NAME = "universal"

print(PINECONE_API_KEY)
print(PINECONE_ENVIRONMENT)
if not PINECONE_API_KEY or not PINECONE_ENVIRONMENT:
    raise SystemExit("Exiting: PINECONE_API_KEY and PINECONE_ENVIRONMENT must be set")

pinecone.init(
    api_key=PINECONE_API_KEY,
    environment=PINECONE_ENVIRONMENT  # find next to API key in console
)

dimension = 1536
metric = "cosine"
pod_type = "p1"
if not pinecone.list_indexes() or TABLE_NAME not in pinecone.list_indexes():
    pinecone.create_index(
        TABLE_NAME, dimension=dimension, metric=metric, pod_type=pod_type
    )
index = pinecone.Index(TABLE_NAME)
# end pinecone stuff

application = Flask(__name__)
CORS(application)

class ChainStreamHandler(StreamingStdOutCallbackHandler):
    def __init__(self, gen):
        super().__init__()
        # this is a generator that will be used to stream the response to the frontend
        self.gen = gen

    def on_llm_new_token(self, token: str, **kwargs):
        print(token, sep="", end="", flush=True)
        self.gen.send(token)

# this is a generator that will be used to stream the response to the frontend
class ThreadedGenerator:
    def __init__(self):
        self.queue = queue.Queue()

    def __iter__(self):
        return self

    def __next__(self):
        item = self.queue.get()
        if item is StopIteration: raise item
        return item

    def send(self, data):
        self.queue.put(data)

    def close(self):
        self.queue.put(StopIteration)

def llm_chain_thread(g, openai_key, prompt, query):

    from langchain.chains import ConversationChain
    from langchain.memory import ConversationBufferMemory
    from langchain.llms import OpenAI
    from langchain.callbacks.base import CallbackManager

    try:
        llm = OpenAI(temperature=0, openai_api_key=openai_key, max_tokens=1000, model_name=MODEL_NAME, streaming=True, verbose=True, callback_manager=CallbackManager([ChainStreamHandler(g)]))
        memory = ConversationBufferMemory()

        conversation_chain = ConversationChain(
            llm=llm,
            memory=memory,
            prompt=prompt,
        )

        conversation_chain.run(input=query)
    finally:
        g.close()

def encode(text):
    import tiktoken
    enc = tiktoken.encoding_for_model(MODEL_NAME)
    return enc.encode(text)

def decode(text):
    import tiktoken
    enc = tiktoken.encoding_for_model(MODEL_NAME)
    return enc.decode(text)

@application.route('/embed/<string:video_id>', methods=['POST'])
@cross_origin(supports_credentials=True)
def embed(video_id):
    openai_key = None
    headers = request.headers
    auth = headers.get("Authorization", "")
    if len(auth.split("Basic")) == 2:
        openai_key = auth.split("Basic")[1]
    if not openai_key:
        response = application.response_class(
            response=json.dumps({"error": "No OpenAI key provided"}),
            status=403,
            mimetype='application/json'
        )
        return response
    
    print(video_id, index.describe_index_stats()['namespaces'])
    if video_id in index.describe_index_stats()['namespaces']:
        response = application.response_class(
            response=json.dumps({"text": "Video already embedded"}),
            status=200,
            mimetype='application/json'
        )
        return response
    
    video_transcription = transcribe(video_id)
    
    # we also want to record the time ranges as metadata
    # chunking logic is as follows:
    # 1. set a max chunk size of 300 tokens with an overlap of 100 tokens
    # 2. start adding sentences to the chunk until the chunk size is reached
    # 3. if the chunk size is reached, then add the last sentence to the next chunk

    text_chunks = []
    time_ranges = []
    space_token = encode(" ")

    curr_chunk = []
    chunk_start_time = 0
    chunk_end_time = 0
    for text in video_transcription:
        if len(curr_chunk) == 0:
            chunk_start_time = text['start']
        curr_tokens = encode(text['text'])
        if len(curr_chunk) + len(curr_tokens) <= MAX_CHUNK_SIZE:
            curr_chunk += space_token + curr_tokens
        else:
            # reset chunk
            text_chunks.append(decode(curr_chunk))
            time_ranges.append((chunk_start_time/60, chunk_end_time/60))
            curr_chunk = curr_chunk[-OVERLAP_SIZE:] + space_token + curr_tokens
            chunk_start_time = text['start']
        
        chunk_end_time = text['start'] + text['duration']
    
    if len(video_transcription) == 0 or len(text_chunks) == 0:
        response = application.response_class(
            response=json.dumps({"error": "No transcription found"}),
            status=404,
            mimetype='application/json'
        )
        return response

    # Embed the chunks
    while True:
        try:
            openai_embeddings = OpenAIEmbeddings(model="text-embedding-ada-002",
                                                openai_api_key=openai_key)
            

            print("Embedding chunks")
            for i, (chunk, time_ranges) in enumerate(zip(text_chunks, time_ranges)):
                embedding = openai_embeddings.embed_query(chunk)
                index.upsert(vectors=[{"id": f"chunk-{i:05}", "values": embedding, "metadata": {"start_time": time_ranges[0], "end_time": time_ranges[1], "chunk": chunk}}], namespace=video_id)
            print("Done embedding chunks")
            
            response = application.response_class(
                response=json.dumps({"text": "Video embedded"}),
                status=200,
                mimetype='application/json'
            )
            return response
        except openai.error.AuthenticationError:
            response = application.response_class(
                response=json.dumps({"error": "Invalid OpenAI key"}),
                status=401,
                mimetype='application/json'
            )
            return response
        except openai.error.RateLimitError:
            print("Rate limit error, sleeping for 10 seconds")
            time.sleep(10)
            continue
        except Exception as e:
            print(e)
            response = application.response_class(
                response=json.dumps({"error": "Unknown error"}),
                status=500,
                mimetype='application/json'
            )
            return response


@application.route('/query/<string:video_id>', methods=['GET'])
@cross_origin(supports_credentials=True)
def query(video_id):
    openai_key = None
    headers = request.headers
    auth = headers.get("Authorization", "")
    if len(auth.split("Basic")) == 2:
        openai_key = auth.split("Basic")[1]
    
    if not openai_key:
        response = application.response_class(
            response=json.dumps({"error": "No OpenAI key provided"}),
            status=403,
            mimetype='application/json'
        )
        return response
    
    query = request.args.get('query', "")
    if not query:
        response = application.response_class(
            response=json.dumps({"error": "No query provided"}),
            status=400,
            mimetype='application/json'
        )
        return response
    
    if video_id not in index.describe_index_stats()['namespaces']:
        response = application.response_class(
            response=json.dumps({"error": "Video not embedded"}),
            status=404,
            mimetype='application/json'
        )
        return response
    
    openai_embeddings = OpenAIEmbeddings(model="text-embedding-ada-002",
                                                openai_api_key=openai_key)
    query_embedding = openai_embeddings.embed_query(query)
    results = index.query(query_embedding, top_k=5, include_metadata=True, namespace=video_id)
    snippets = "\n".join([result['metadata']['chunk'] for result in results["matches"]])

    from langchain.prompts import PromptTemplate

    prompt = PromptTemplate(
    input_variables=["history", "input"],
    template=""""The following is a friendly conversation between a human and YouQ. YouQ is an assistant that answers any question the human has about the youtube video being watched as well as provide more context about the video. YouQis talkative and provides lots of specific details from its context. YouQ is given snippets of a transcript from a video. YouQ can use the snippets to answer the question. If YouQ does not know the answer to a question, it truthfully says it does not know.
YouQ must not mention any information about having knowledge of the transcripts    

Snippets:

""" + snippets + """

Current conversation:
{history}
Friend: {input}
YouQ:
""",
)

    g = ThreadedGenerator()
    print("Starting thread")
    # start thread
    threading.Thread(target=llm_chain_thread, args=(g, openai_key, prompt, query)).start()
    return Response(g, mimetype='text/event-stream')
    # return response    

def transcribe(video_id):
    try:
        return YouTubeTranscriptApi.get_transcript(video_id, languages=['en'])
    except _errors.TranscriptsDisabled:
        return []
    except Exception as e:
        return []

if __name__ == '__main__':
    application.run(host='0.0.0.0', port=80)