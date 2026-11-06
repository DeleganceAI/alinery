// O1 (b) sample: grpc-js on the wire, while daemon handlers keep Connect's ServiceImpl shape
// (async functions and async generators that read ctx.signal). The same impl object also runs
// in memory under createRouterTransport in tests (2.5), so there is one handler code path.
import { create, fromBinary, toBinary, type DescService } from "@bufbuild/protobuf";
import { ConnectError, createHandlerContext, type ContextValues, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { setTrailerStatus } from "@connectrpc/connect/protocol-grpc";
import * as grpc from "@grpc/grpc-js";

// One generator for every side: a grpc-js definition built from the protobuf-es descriptor.
export function grpcDefinition(service: DescService): grpc.ServiceDefinition {
  const def: grpc.ServiceDefinition = {};
  for (const m of service.methods) {
    def[m.localName] = {
      path: `/${service.typeName}/${m.name}`,
      requestStream: m.methodKind === "client_streaming" || m.methodKind === "bidi_streaming",
      responseStream: m.methodKind === "server_streaming" || m.methodKind === "bidi_streaming",
      requestSerialize: (v) => Buffer.from(toBinary(m.input, create(m.input, v))),
      requestDeserialize: (b: Buffer) => fromBinary(m.input, b),
      responseSerialize: (v) => Buffer.from(toBinary(m.output, create(m.output, v))),
      responseDeserialize: (b: Buffer) => fromBinary(m.output, b),
    };
  }
  return def;
}

// Connect codes are numbered as gRPC codes. Error details travel in grpc-status-details-bin,
// which connect-web's gRPC-web client reads back as ConnectError details.
function toStatus(e: unknown): Partial<grpc.ServiceError> {
  const err = ConnectError.from(e);
  const metadata = new grpc.Metadata();
  const bin = setTrailerStatus(new Headers(), err).get("grpc-status-details-bin");
  if (bin) metadata.set("grpc-status-details-bin", Buffer.from(bin, "base64"));
  return { code: err.code as number, details: err.rawMessage, metadata };
}

type AnyCall = grpc.ServerUnaryCall<unknown, unknown> | grpc.ServerWritableStream<unknown, unknown>;

/** `values` runs first for every call: it checks the credential and returns the call's context
 * values (capabilities), or throws a ConnectError such as Unauthenticated. */
export function addService<S extends DescService>(
  server: grpc.Server,
  service: S,
  impl: Partial<ServiceImpl<S>>,
  values: (header: Headers) => ContextValues,
) {
  const context = (call: AnyCall, method: S["methods"][number]): HandlerContext => {
    const ac = new AbortController();
    call.on("cancelled", () => ac.abort());
    const header = new Headers();
    for (const [k, v] of Object.entries(call.metadata.getMap())) if (typeof v === "string") header.set(k, v);
    return createHandlerContext({
      service, method, protocolName: "grpc", requestMethod: "POST", url: `/${service.typeName}/${method.name}`,
      requestSignal: ac.signal, requestHeader: header, contextValues: values(header),
    });
  };
  const handlers: grpc.UntypedServiceImplementation = {};
  for (const m of service.methods) {
    const fn = impl[m.localName as keyof typeof impl] as unknown as ((req: unknown, ctx: HandlerContext) => unknown) | undefined;
    if (!fn) continue;
    if (m.methodKind === "unary") {
      handlers[m.localName] = (call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        Promise.resolve()
          .then(() => fn(call.request, context(call, m)))
          .then((res) => cb(null, res), (e) => cb(toStatus(e)));
      };
    } else if (m.methodKind === "server_streaming") {
      handlers[m.localName] = async (call: grpc.ServerWritableStream<unknown, unknown>) => {
        let ctx: HandlerContext | undefined;
        try {
          ctx = context(call, m);
          const signal = ctx.signal;
          for await (const msg of fn(call.request, ctx) as AsyncIterable<unknown>) {
            if (signal.aborted) break;
            // write() returns false when the HTTP/2 buffer is full: wait for drain or cancel.
            if (!call.write(msg)) await new Promise((r) => { call.once("drain", r); signal.addEventListener("abort", r); });
          }
          if (!signal.aborted) call.end();
        } catch (e) {
          if (!ctx?.signal.aborted) call.emit("error", toStatus(e));
        }
      };
    } else {
      // The webview's fetch has no request stream; terminals use the split form (O8 a).
      throw new Error(`${m.name}: client and bidi streams are not served`);
    }
  }
  server.addService(grpcDefinition(service), handlers);
}
