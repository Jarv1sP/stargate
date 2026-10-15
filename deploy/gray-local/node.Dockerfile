FROM fedora:42
ENV container=docker
RUN dnf -y -q install systemd openssh-server openssh-clients python3 python3.10 bubblewrap slirp4netns podman crun shadow-utils skopeo procps-ng psmisc iproute util-linux findutils git e2fsprogs \
 && dnf clean all \
 && systemctl mask systemd-firstboot.service console-getty.service getty.target systemd-udevd.service \
 && useradd --create-home --shell /bin/bash --uid 1001 gpuops \
 && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/gpuops \
 && ssh-keygen -A && rm -f /etc/containers/registries.conf.d/* \
 && chmod u+s /usr/bin/newuidmap /usr/bin/newgidmap \
 && : > /usr/share/containers/mounts.conf
# dnf 安装与清理全部结束后再切换节点解释器。
RUN ln -sf python3.10 /usr/bin/python3 && python3 --version && dnf --version
COPY python.tar /opt/gray-python.tar
RUN skopeo copy docker-archive:/opt/gray-python.tar oci-archive:/opt/gray-python.oci.tar:gray-python && rm /opt/gray-python.tar
COPY release/ /opt/gray-release/
COPY gpus.json /etc/gray-sim/gpus.json
COPY node-setup.sh /usr/local/sbin/gray-node-setup
COPY fake-nvidia-smi.py /opt/gray-sim/nvidia-smi
COPY gray-node-setup.service /etc/systemd/system/gray-node-setup.service
RUN chmod 755 /usr/local/sbin/gray-node-setup /opt/gray-sim/nvidia-smi \
 && systemctl enable gray-node-setup.service sshd.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
