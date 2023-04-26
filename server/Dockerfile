FROM python:3
COPY ./application.py /deploy/
COPY ./requirements.txt /deploy/
WORKDIR /deploy
RUN pip3 install --no-cache-dir -r requirements.txt
EXPOSE 80
ENTRYPOINT ["python", "application.py"]