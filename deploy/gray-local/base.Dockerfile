FROM python:3.13-bookworm
COPY gpus.json /etc/gray-sim/gpus.json
RUN git --version
