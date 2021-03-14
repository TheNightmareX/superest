import { Field, FieldOptions, Lazy, Values } from "./fields";
import { IsInstanceValidator, ValidationError } from "./validators";

export type PK = string | number;

export type NonPromise<T> = T extends Promise<infer R> ? R : T;

export interface Action<
  Res extends Resource<any, any, any, any> = Resource<any, any, any, any>
> {
  (resource: Res): Function;
}

/**
 * The generic type `F` here is used to get the detailed literal types of the fields' meta.
 * When `F` is not set as a generic type, literal types such as `true` or `"a string"` will be replaced to
 * `boolean` and `string`.
 */
export interface FieldsOptions<F extends Field = Field>
  extends Record<"default" | "response" | "request", Record<string, F>> {}

export interface GettersOptions<Fields extends FieldsOptions>
  extends Record<string, (data: FieldsValues<Fields>["internal"]) => unknown> {}

export interface ActionsOptions<
  Fields extends FieldsOptions,
  Getters extends GettersOptions<Fields>,
  Actions extends ActionsOptions<Fields, Getters, Actions>
> extends Record<string, Action<Resource<Fields, Getters, Actions, Field>>> {}

export interface ResourceOptions<
  Fields extends FieldsOptions,
  Getters extends GettersOptions<Fields>,
  Actions extends ActionsOptions<Fields, Getters, Actions>
> {
  basename: string;
  objects?: Record<PK, Data<Fields, Getters>>;
  fields: Fields;
  pkField: keyof (Fields["default"] & Fields["response"]);
  actions: Actions;
  getters?: Getters;
}

export type FieldsValues<Fields extends FieldsOptions> = {
  rawInternal: {
    [N in keyof (Fields["default"] & Fields["response"])]: Values<
      (Fields["default"] & Fields["response"])[N]
    >["rawInternal"];
  };
  internal: {
    [N in keyof (Fields["default"] & Fields["response"])]: Values<
      (Fields["default"] & Fields["response"])[N]
    >["internal"];
  };
  rawExternal: {
    [N in keyof (Fields["default"] & Fields["request"])]: Values<
      (Fields["default"] & Fields["request"])[N]
    >["rawExternal"];
  };
  external: {
    [N in keyof (Fields["default"] & Fields["request"])]: Values<
      (Fields["default"] & Fields["request"])[N]
    >["external"];
  };
};

export type Data<
  Fields extends FieldsOptions,
  Getters extends GettersOptions<Fields>
> = FieldsValues<Fields>["internal"] &
  { [K in keyof Getters]: ReturnType<Getters[K]> };

export type ResData<Res> = Res extends Resource<
  infer Fields,
  infer Getters,
  infer Actions,
  infer F
>
  ? Data<Fields, Getters>
  : unknown;

export class Resource<
  Fields extends FieldsOptions<F>,
  Getters extends GettersOptions<Fields>,
  Actions extends ActionsOptions<Fields, Getters, Actions>,
  F extends Field
> {
  readonly basename;
  readonly objects;
  protected readonly fields;
  protected readonly pkField;
  protected readonly getters;
  readonly actions;

  readonly Field;
  readonly asField: InstanceType<
    Resource<Fields, Getters, Actions, F>["Field"]
  >;

  constructor({
    basename,
    objects = {},
    fields,
    pkField,
    getters,
    actions,
  }: ResourceOptions<Fields, Getters, Actions>) {
    this.basename = basename;
    this.objects = objects;
    this.fields = fields;
    this.pkField = pkField;
    this.getters = getters;
    this.actions = Object.fromEntries(
      Object.entries(actions).map(([name, build]) => [name, build(this)])
    ) as { [N in keyof Actions]: ReturnType<Actions[N]> };
    this.Field = this.buildField();
    this.asField = new this.Field({});
  }

  clearObjects() {
    for (const k in this.objects) {
      delete this.objects[k];
    }
  }

  getURL(pk: PK = "", action = "") {
    return `/${this.basename}/${pk && pk + "/"}${action && action + "/"}`;
  }

  protected getPK(value: FieldsValues<Fields>["internal"] | PK) {
    return typeof value == "object" ? (value[this.pkField] as PK) : value;
  }

  protected matchFields<K extends string, V, R>(
    data: Record<K, V>,
    fields: Record<string, Field>,
    callback: (k: K, v: V, field: Field) => R
  ) {
    const entries = Object.entries(data)
      .filter(([k]) => !!fields[k])
      .map(([k, v]) => [k, callback(k as K, v as V, fields[k])]);
    return Object.fromEntries(entries) as Record<K, R>;
  }

  commit(data: Lazy<FieldsValues<Fields>["internal"]>): Data<Fields, Getters>;
  commit(
    data: Lazy<FieldsValues<Fields>["internal"]>[]
  ): Data<Fields, Getters>[];
  commit(
    data:
      | Lazy<FieldsValues<Fields>["internal"]>
      | Lazy<FieldsValues<Fields>["internal"]>[]
  ) {
    // define descriptors because Vue 2.x will also define descriptors on the object
    // to observe changes, which will cover the raw data and make the `Proxy` get a wrong
    // value
    if (data instanceof Array) return data.map((data) => this.commit(data));
    type V = Data<Fields, Getters>;
    const fields = {
      ...this.fields.default,
      ...this.fields.response,
      ...this.fields.request,
    };
    const getters = this.getters;
    const processed = {};
    for (const k in data) {
      Object.defineProperty(processed, k, {
        get: () => data[k](),
        set: (v) => {
          fields[k].runAllValidations(v);
          data[k as keyof typeof data] = () => v;
        },
        configurable: true,
        enumerable: true,
      });
    }
    if (getters)
      for (const k in getters) {
        Object.defineProperty(processed, k, {
          get: () => getters[k](processed as V),
          configurable: true,
          enumerable: true,
        });
      }

    /**
     * Make sure that the object obtained through a same pk always be the same one,
     * otherwise the following case may happen and cause confusion.
     *
     *      await res.retrieve(1)
     *      const objOld = res.objects[1]
     *      await res.retrieve(1)
     *      const objNew = res.objects[1]
     *      console.log(objOld.pk == objNew.pk) // true
     *      console.log(objOld == objNew) // false
     *
     */
    const save = (data: V) => {
      const pk = this.getPK(data);

      if (!this.objects[pk]) {
        this.objects[pk] = data;
        return data;
      } else {
        Object.entries(data).forEach(([k, v]) => {
          if (this.getters && k in this.getters) return;
          this.objects[pk][k as keyof V] = v as V[keyof V];
        });
        return this.objects[pk];
      }
    };
    return save(processed as V);
  }

  protected buildField() {
    // eslint-disable-next-line
    const resource = this;

    type RawInternal = FieldsValues<Fields>["rawInternal"] | PK;
    type Internal = Data<Fields, Getters>;
    type rawExternal = FieldsValues<Fields>["rawExternal"];
    type External = FieldsValues<Fields>["external"];

    return class ResourceField<Opts extends FieldOptions> extends Field<
      Opts,
      RawInternal,
      Internal,
      rawExternal,
      External
    > {
      constructor(options: Opts) {
        super(options);
        this.validators.push(new IsInstanceValidator(Object));
      }

      toInternalValue(value: RawInternal): () => Internal {
        if (typeof value == "object") {
          const data = resource.commit(
            resource.matchFields(
              value,
              {
                ...resource.fields.default,
                ...resource.fields.response,
              },
              (k, v, field) =>
                this.handleValidationError(
                  field.toInternal.bind(field),
                  value,
                  k
                )(v)
            ) as Lazy<Internal>
          );
          return () => data;
        } else {
          return () => resource.objects[value];
        }
      }
      toExternalValue(value: rawExternal): External {
        return resource.matchFields(
          value,
          {
            ...resource.fields.default,
            ...resource.fields.request,
          },
          (k, v, field) =>
            this.handleValidationError(
              field.toExternal.bind(field),
              value,
              k
            )(v)
        ) as External;
      }

      validate(value: Record<string, unknown>) {
        resource.matchFields(
          value,
          {
            ...resource.fields.default,
            ...resource.fields.response,
            ...resource.fields.request,
          },
          (k, v, field) => field.runAllValidations(v)
        );
      }

      handleValidationError<T extends (...args: unknown[]) => unknown>(
        fn: T,
        data: unknown,
        key: string
      ) {
        return (...args: Parameters<T>) => {
          try {
            return fn(...args) as ReturnType<T>;
          } catch (error) {
            if (error instanceof ValidationError) {
              error.data = data;
              error.path.unshift(key);
            }
            throw error;
          }
        };
      }
    };
  }
}
