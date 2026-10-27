FROM debian:12
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server tar gzip git coreutils procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev \
 && mkdir -p /home/dev/.ssh \
 && git config --system user.email test@example.com && git config --system user.name test
COPY id_test.pub /home/dev/.ssh/authorized_keys
RUN chown -R dev:dev /home/dev/.ssh && chmod 700 /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys \
 && mkdir -p /home/dev/work/proj && chown -R dev:dev /home/dev/work
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
