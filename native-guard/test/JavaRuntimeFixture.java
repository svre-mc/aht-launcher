public class JavaRuntimeFixture {
    public static volatile long value;
    public static void main(String[] args)throws Exception {
        System.out.println(java.lang.management.ManagementFactory.getRuntimeMXBean().getName().split("@")[0]);
        long until=System.currentTimeMillis()+45000;
        while(System.currentTimeMillis()<until){for(int i=0;i<20000;i++)value+=i%17;Thread.sleep(10);}
    }
}
