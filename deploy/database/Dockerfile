# PostgreSQL 17 with a rebuilt privilege helper; base and source are pinned.
FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS gosu
WORKDIR /source
ADD --checksum=sha256:2b70da8a5480fafedc16bb1fc91b572f064d03df736cbd91a616af2f1b66ab51 https://codeload.github.com/tianon/gosu/tar.gz/29b939aa5bd4dc588af765b8248f6e39150d2565 /tmp/gosu.tar.gz
RUN tar -xzf /tmp/gosu.tar.gz --strip-components=1 -C /source \
    && go get golang.org/x/sys@v0.44.0 \
    && go mod verify \
    && CGO_ENABLED=0 go build -trimpath -o /gosu .

FROM postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
LABEL org.opencontainers.image.source="https://github.com/picli3/sugar"
RUN apk upgrade --no-cache krb5-libs libxslt
COPY --from=gosu /gosu /usr/local/bin/gosu
COPY --from=gosu /source/LICENSE /usr/share/licenses/gosu/LICENSE
RUN gosu --version && gosu nobody true
